// The strategies the router switches between, each executed through the guarded
// paths that already exist:
//   stake    -> staking planner + transaction firewall + simulation (src/core)
//   hedge    -> SOL <-> USDC through the swap firewall + simulation (src/bot/swap.ts)
//   momentum -> the memecoin engine, given a budget (src/bot/engine.ts)

import type { AppConfig } from '../config.ts';
import type { Address, Signer } from '../crypto/keys.ts';
import { loadChainContext, type ChainContext } from '../core/chain.ts';
import { prepare, signAndSend, type ExecContext } from '../core/executor.ts';
import { planDeposit, planWithdraw, selectDepositPool } from '../core/planner.ts';
import { evaluatePools, type PoolEvaluation } from '../core/pools.ts';
import { loadPortfolio, type Portfolio, type Position } from '../core/portfolio.ts';
import { decodeTokenAccount } from '../solana/accounts.ts';
import { TOKEN_PROGRAM_ID } from '../solana/constants.ts';
import { deriveAssociatedTokenAddress } from '../solana/programs.ts';
import type { Rpc } from '../solana/rpc.ts';
import type { JupiterClient } from '../bot/jupiter.ts';
import { WSOL_MINT } from '../bot/jupiter.ts';
import type { BotState } from '../bot/state.ts';
import { executeSwap, type SwapContext } from '../bot/swap.ts';
import type { Holdings, Move } from './allocator.ts';
import type { RouterPolicy } from './policy.ts';

export interface SleeveDeps {
  cfg: AppConfig;
  rpc: Rpc;
  jupiter: Pick<JupiterClient, 'quote' | 'swapTransaction'>;
  wallet: Address;
  /** null = simulate only. */
  signer: Signer | null;
  router: RouterPolicy;
  maxPriorityFeeLamports: bigint;
  rentTokenAccount: bigint;
  isHalted: () => boolean;
  log: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

export interface Snapshot {
  holdings: Holdings;
  /** Refundable rent sitting in the wallet's own token accounts (counted in total value). */
  lockedRentLamports: bigint;
  chain: ChainContext;
  evaluations: PoolEvaluation[];
  portfolio: Portfolio;
  hedgeAta: Address;
}

export async function takeSnapshot(d: SleeveDeps, momentum: BotState | null): Promise<Snapshot> {
  const chain = await loadChainContext(d.rpc, d.cfg.policy);
  const evaluations = await evaluatePools(d.rpc, d.cfg.pools, chain, d.cfg.policy);
  const portfolio = await loadPortfolio(d.rpc, d.wallet, evaluations);
  const stakeLamports = portfolio.positions.reduce((a, p) => a + p.valueLamports, 0n);
  const hedgeAta = deriveAssociatedTokenAddress(d.wallet, d.router.hedge.mint, TOKEN_PROGRAM_ID);
  const hedgeAcc = await d.rpc.getAccountInfo(hedgeAta);
  const hedgeUnits = hedgeAcc ? decodeTokenAccount(hedgeAcc.data).amount : 0n;
  let hedgeLamports = 0n;
  if (hedgeUnits > 0n) {
    // Executable value: what selling it back would actually return.
    hedgeLamports = (await d.jupiter.quote({ inputMint: d.router.hedge.mint, outputMint: WSOL_MINT, amount: hedgeUnits, slippageBps: d.router.hedge.slippageBps })).outAmount;
  }
  const momentumPositions = momentum?.positions ?? [];
  const momentumLamports = momentumPositions.reduce((a, p) => a + BigInt(p.lastValueLamports), 0n);
  const lockedRentLamports =
    portfolio.positions.reduce((a, p) => a + p.ataLamports, 0n) + (hedgeAcc?.lamports ?? 0n) + BigInt(momentumPositions.length) * d.rentTokenAccount;
  return {
    holdings: { solLamports: portfolio.solLamports, stakeLamports, hedgeLamports, hedgeUnits, momentumLamports },
    lockedRentLamports,
    chain,
    evaluations,
    portfolio,
    hedgeAta,
  };
}

function swapContext(d: SleeveDeps): SwapContext {
  return {
    rpc: d.rpc,
    jupiter: d.jupiter,
    wallet: d.wallet,
    signer: d.signer,
    maxPriorityFeeLamports: d.maxPriorityFeeLamports,
    rentTokenAccount: d.rentTokenAccount,
    isHalted: d.isHalted,
    log: d.log,
    ...(d.sleep ? { sleep: d.sleep } : {}),
  };
}

export interface MoveResult {
  ok: boolean;
  status: string;
  detail: string;
}

/** Executes (or, without a signer, simulates) one stake or hedge move. */
export async function executeMove(d: SleeveDeps, snap: Snapshot, move: Move): Promise<MoveResult> {
  const execCtx: ExecContext = { rpc: d.rpc, policy: d.cfg.policy, evaluations: snap.evaluations, log: d.log, ...(d.sleep ? { sleep: d.sleep } : {}) };
  switch (move.kind) {
    case 'stake-deposit': {
      const chosen = selectDepositPool(snap.evaluations, snap.portfolio, d.cfg.policy);
      if ('kind' in chosen) return { ok: false, status: 'skipped', detail: chosen.reasons.join('; ') };
      // Larger amounts go in over several moves: the staking policy caps each transaction.
      const cap = d.cfg.policy.maxLamportsPerTransaction;
      const requestedLamports = move.lamports > cap ? cap : move.lamports;
      const plan = planDeposit({ portfolio: snap.portfolio, evaluation: chosen, policy: d.cfg.policy, rentTokenAccount: snap.chain.rentTokenAccount, requestedLamports });
      if (plan.kind === 'noop') return { ok: false, status: 'skipped', detail: plan.reasons.join('; ') };
      const prepared = await prepare(execCtx, plan);
      if (!d.signer) return { ok: true, status: 'simulated', detail: prepared.checks.join('; ') };
      const out = await signAndSend(execCtx, prepared, d.signer, d.isHalted);
      return { ok: out.status === 'confirmed', status: out.status, detail: out.signature };
    }
    case 'stake-withdraw': {
      const held = snap.portfolio.positions.filter((p) => p.tokens > 0n).sort((a, b) => (b.valueLamports > a.valueLamports ? 1 : -1));
      const position = held[0] as Position | undefined;
      if (!position || !position.evaluation.verified) return { ok: false, status: 'skipped', detail: 'no staked position' };
      const pool = position.evaluation.verified.pool;
      const tokens = move.all || move.lamports >= position.valueLamports ? position.tokens : (move.lamports * pool.poolTokenSupply + pool.totalLamports - 1n) / pool.totalLamports;
      const plan = planWithdraw({ portfolio: snap.portfolio, position, policy: d.cfg.policy, requestedTokens: tokens > position.tokens ? position.tokens : tokens });
      if (plan.kind === 'noop') return { ok: false, status: 'skipped', detail: plan.reasons.join('; ') };
      const prepared = await prepare(execCtx, plan);
      if (!d.signer) return { ok: true, status: 'simulated', detail: prepared.checks.join('; ') };
      const out = await signAndSend(execCtx, prepared, d.signer, d.isHalted);
      return { ok: out.status === 'confirmed', status: out.status, detail: out.signature };
    }
    case 'hedge-buy':
    case 'hedge-sell': {
      const buy = move.kind === 'hedge-buy';
      const r = await executeSwap(swapContext(d), {
        inputMint: buy ? WSOL_MINT : d.router.hedge.mint,
        outputMint: buy ? d.router.hedge.mint : WSOL_MINT,
        inputTokenProgram: TOKEN_PROGRAM_ID,
        outputTokenProgram: TOKEN_PROGRAM_ID,
        amount: buy ? move.lamports : move.units,
        slippageBps: d.router.hedge.slippageBps,
        maxPriceImpactPct: d.router.hedge.maxPriceImpactPct,
      });
      return { ok: r.status === 'confirmed' || r.status === 'simulated', status: r.status, detail: r.signature ?? r.actions.join('; ') };
    }
    default:
      return { ok: true, status: 'noop', detail: 'handled by the router' };
  }
}
