// Turns (wallet state, verified pool state, policy) into an exact, explainable plan.
// Pure functions: no I/O, so every rule here is unit-tested.

import type { Address } from '../crypto/keys.ts';
import type { Instruction } from '../solana/tx.ts';
import {
  closeTokenAccount,
  createAssociatedTokenAccountIdempotent,
  deriveAssociatedTokenAddress,
  depositSol,
  setComputeUnitLimit,
  setComputeUnitPrice,
  withdrawSol,
} from '../solana/programs.ts';
import { BASE_FEE_LAMPORTS_PER_SIGNATURE } from '../solana/constants.ts';
import { bps, formatSol } from '../util/amount.ts';
import { CalculationError, poolTokensToLamports, quoteDepositSol, quoteWithdrawSol, type DepositSolQuote, type WithdrawSolQuote } from './math.ts';
import type { Policy } from './policy.ts';
import type { PoolEvaluation, VerifiedPool } from './pools.ts';
import type { Portfolio, Position } from './portfolio.ts';
import { rankPools } from './pools.ts';

export interface DepositPlan {
  kind: 'deposit';
  evaluation: PoolEvaluation;
  verified: VerifiedPool;
  wallet: Address;
  ata: Address;
  createAta: boolean;
  ataRentLamports: bigint;
  lamports: bigint;
  quote: DepositSolQuote;
  /** Enforced on-chain by DepositSolWithSlippage. */
  minPoolTokensOut: bigint;
  /** userTokens + referral share (the referral account is our own ATA). */
  receivedTokens: bigint;
  receivedValueLamports: bigint;
  entryCostLamports: bigint;
  entryCostBps: number;
  feeBudgetLamports: bigint;
  /** Wallet SOL after the transaction in the worst case (maximum fee). */
  solAfterLamports: bigint;
  notes: string[];
}

export interface WithdrawPlan {
  kind: 'withdraw';
  evaluation: PoolEvaluation;
  verified: VerifiedPool;
  wallet: Address;
  ata: Address;
  poolTokens: bigint;
  quote: WithdrawSolQuote;
  /** Enforced on-chain by WithdrawSolWithSlippage. */
  minLamportsOut: bigint;
  closeAta: boolean;
  ataRentLamports: bigint;
  exitCostLamports: bigint;
  exitCostBps: number;
  feeBudgetLamports: bigint;
  notes: string[];
}

export interface NoopPlan {
  kind: 'noop';
  reasons: string[];
}

export function feeBudget(policy: Policy): bigint {
  return BASE_FEE_LAMPORTS_PER_SIGNATURE + policy.maxPriorityFeeLamports;
}

function blockers(e: PoolEvaluation, which: 'deposit' | 'withdraw'): string[] {
  return e.issues.filter((i) => (which === 'deposit' ? i.blocksDeposit : i.blocksWithdraw)).map((i) => `${e.config.symbol}: ${i.message}`);
}

/**
 * Chooses where new SOL should go. Tops up an existing position rather than opening a
 * second one unless another pool beats it by more than the switch threshold.
 */
export function selectDepositPool(evaluations: PoolEvaluation[], portfolio: Portfolio, policy: Policy, symbol?: string): PoolEvaluation | NoopPlan {
  if (symbol) {
    const e = evaluations.find((x) => x.config.symbol.toLowerCase() === symbol.toLowerCase());
    if (!e) return { kind: 'noop', reasons: [`unknown pool "${symbol}" (allowlist: ${evaluations.map((x) => x.config.symbol).join(', ')})`] };
    return e;
  }
  const ranked = rankPools(evaluations).filter((e) => e.depositable);
  const best = ranked[0];
  if (!best) {
    const reasons = evaluations.flatMap((e) => blockers(e, 'deposit'));
    return { kind: 'noop', reasons: reasons.length ? reasons : ['no allowlisted pool is currently depositable'] };
  }
  const held = portfolio.positions
    .filter((p) => p.tokens > 0n && p.evaluation.depositable)
    .sort((a, b) => (b.valueLamports > a.valueLamports ? 1 : -1))[0];
  if (held && held.evaluation !== best) {
    const gain = ((best.metrics?.score ?? 0) - (held.evaluation.metrics?.score ?? 0)) * 100;
    if (gain < policy.switchMinAprGainPct) return held.evaluation;
  }
  return best;
}

export function planDeposit(params: {
  portfolio: Portfolio;
  evaluation: PoolEvaluation;
  policy: Policy;
  rentTokenAccount: bigint;
  requestedLamports?: bigint;
}): DepositPlan | NoopPlan {
  const { portfolio, evaluation, policy, rentTokenAccount, requestedLamports } = params;
  const v = evaluation.verified;
  if (!v) return { kind: 'noop', reasons: blockers(evaluation, 'deposit') };
  const reasons = [...blockers(evaluation, 'deposit'), ...portfolio.issues.filter((i) => i.blocksDeposit).map((i) => i.message)];
  const position = portfolio.positions.find((p) => p.evaluation.config.symbol === evaluation.config.symbol);
  if (position) reasons.push(...position.issues.filter((i) => i.blocksDeposit).map((i) => i.message));
  if (reasons.length) return { kind: 'noop', reasons };

  const ata = deriveAssociatedTokenAddress(portfolio.wallet, v.pool.poolMint, v.pool.tokenProgramId);
  const createAta = !(position?.exists ?? false);
  const ataRentLamports = createAta ? rentTokenAccount : 0n;
  const fees = feeBudget(policy);
  const notes: string[] = [];

  const spendable = portfolio.solLamports - policy.reserveLamports - ataRentLamports - fees;
  if (spendable <= 0n) {
    return {
      kind: 'noop',
      reasons: [
        `nothing to deposit: wallet holds ${formatSol(portfolio.solLamports)} SOL and ${formatSol(policy.reserveLamports + ataRentLamports + fees)} SOL must stay liquid (fee reserve${createAta ? ' + token account rent' : ''} + max tx fee)`,
      ],
    };
  }
  let lamports: bigint;
  if (requestedLamports !== undefined) {
    if (requestedLamports > spendable) {
      return { kind: 'noop', reasons: [`requested ${formatSol(requestedLamports)} SOL but only ${formatSol(spendable)} SOL can be deposited while keeping the reserve`] };
    }
    if (requestedLamports > policy.maxLamportsPerTransaction) {
      return { kind: 'noop', reasons: [`requested amount exceeds policy maxSolPerTransaction (${formatSol(policy.maxLamportsPerTransaction)} SOL)`] };
    }
    lamports = requestedLamports;
  } else {
    lamports = spendable;
    if (lamports > policy.maxLamportsPerTransaction) {
      lamports = policy.maxLamportsPerTransaction;
      notes.push(`capped at policy maxSolPerTransaction (${formatSol(lamports)} SOL); run again to deposit the rest`);
    }
  }
  if (lamports < policy.minDepositLamports) {
    return { kind: 'noop', reasons: [`only ${formatSol(lamports)} SOL is depositable, below policy minimum ${formatSol(policy.minDepositLamports)} SOL`] };
  }

  let quote: DepositSolQuote;
  try {
    quote = quoteDepositSol(v.pool, lamports);
  } catch (e) {
    if (e instanceof CalculationError) return { kind: 'noop', reasons: [e.message] };
    throw e;
  }
  const minPoolTokensOut = (quote.userTokens * BigInt(10_000 - policy.slippageBps)) / 10_000n;
  const receivedTokens = quote.userTokens + quote.referralFeeTokens;
  const receivedValueLamports = poolTokensToLamports(v.pool, receivedTokens);
  const entryCostLamports = lamports - receivedValueLamports;
  const entryCostBps = bps(entryCostLamports, lamports);
  if (entryCostBps > policy.maxDepositCostBps) {
    return { kind: 'noop', reasons: [`entry cost ${entryCostBps.toFixed(2)} bps exceeds policy maxDepositCostBps ${policy.maxDepositCostBps}`] };
  }
  if (createAta) notes.push(`creates your ${evaluation.config.symbol} token account (${formatSol(rentTokenAccount)} SOL rent, refunded if the account is closed)`);
  return {
    kind: 'deposit',
    evaluation,
    verified: v,
    wallet: portfolio.wallet,
    ata,
    createAta,
    ataRentLamports,
    lamports,
    quote,
    minPoolTokensOut,
    receivedTokens,
    receivedValueLamports,
    entryCostLamports,
    entryCostBps,
    feeBudgetLamports: fees,
    solAfterLamports: portfolio.solLamports - lamports - ataRentLamports - fees,
    notes,
  };
}

export function selectWithdrawPosition(portfolio: Portfolio, symbol?: string): Position | NoopPlan {
  const held = portfolio.positions.filter((p) => p.tokens > 0n);
  if (symbol) {
    const p = portfolio.positions.find((x) => x.evaluation.config.symbol.toLowerCase() === symbol.toLowerCase());
    if (!p || p.tokens === 0n) return { kind: 'noop', reasons: [`no ${symbol} position to withdraw`] };
    return p;
  }
  if (held.length === 0) return { kind: 'noop', reasons: ['no staked position to withdraw'] };
  if (held.length > 1) return { kind: 'noop', reasons: [`several positions held (${held.map((p) => p.evaluation.config.symbol).join(', ')}); pass --pool`] };
  return held[0] as Position;
}

export function planWithdraw(params: {
  portfolio: Portfolio;
  position: Position;
  policy: Policy;
  /** Pool tokens to redeem; defaults to the whole position. */
  requestedTokens?: bigint;
  closeWhenEmpty?: boolean;
}): WithdrawPlan | NoopPlan {
  const { portfolio, position, policy, requestedTokens, closeWhenEmpty = true } = params;
  const evaluation = position.evaluation;
  const v = evaluation.verified;
  if (!v) return { kind: 'noop', reasons: blockers(evaluation, 'withdraw') };
  const reasons = [
    ...blockers(evaluation, 'withdraw'),
    ...position.issues.filter((i) => i.blocksWithdraw).map((i) => i.message),
    ...portfolio.issues.filter((i) => i.blocksWithdraw).map((i) => i.message),
  ];
  if (reasons.length) return { kind: 'noop', reasons };

  const poolTokens = requestedTokens ?? position.tokens;
  if (poolTokens <= 0n || poolTokens > position.tokens) {
    return { kind: 'noop', reasons: [`invalid amount: position holds ${position.tokens} base units`] };
  }
  const fees = feeBudget(policy);
  if (portfolio.solLamports < fees) {
    return { kind: 'noop', reasons: [`wallet needs at least ${formatSol(fees)} SOL to pay the transaction fee`] };
  }
  let quote: WithdrawSolQuote;
  try {
    quote = quoteWithdrawSol(v.pool, poolTokens);
  } catch (e) {
    if (e instanceof CalculationError) return { kind: 'noop', reasons: [e.message] };
    throw e;
  }
  if (quote.lamportsOut > v.reserveAvailableLamports) {
    return {
      kind: 'noop',
      reasons: [
        `the pool reserve can pay out ${formatSol(v.reserveAvailableLamports)} SOL right now, less than the ${formatSol(quote.lamportsOut)} SOL needed. ` +
          'Options: retry later (reserves refill as the pool rebalances), withdraw a smaller amount, or redeem via the pool\'s stake withdrawal (docs/RUNBOOK.md).',
      ],
    };
  }
  const minLamportsOut = (quote.lamportsOut * BigInt(10_000 - policy.slippageBps)) / 10_000n;
  const value = poolTokensToLamports(v.pool, poolTokens);
  const exitCostLamports = value - quote.lamportsOut;
  const closeAta = closeWhenEmpty && poolTokens === position.tokens;
  const notes: string[] = [];
  if (closeAta) notes.push(`closes the emptied token account and refunds its ${formatSol(position.ataLamports)} SOL rent`);
  return {
    kind: 'withdraw',
    evaluation,
    verified: v,
    wallet: portfolio.wallet,
    ata: position.ata,
    poolTokens,
    quote,
    minLamportsOut,
    closeAta,
    ataRentLamports: closeAta ? position.ataLamports : 0n,
    exitCostLamports,
    exitCostBps: bps(exitCostLamports, value),
    feeBudgetLamports: fees,
    notes,
  };
}

export interface ComputeSettings {
  unitLimit: number;
  microLamportsPerUnit: bigint;
}

export function priorityFeeLamports(c: ComputeSettings): bigint {
  return (BigInt(c.unitLimit) * c.microLamportsPerUnit + 999_999n) / 1_000_000n;
}

export function buildDepositInstructions(plan: DepositPlan, compute: ComputeSettings, guarded: boolean): Instruction[] {
  const v = plan.verified;
  const ixs: Instruction[] = [setComputeUnitLimit(compute.unitLimit), setComputeUnitPrice(compute.microLamportsPerUnit)];
  if (plan.createAta) {
    ixs.push(createAssociatedTokenAccountIdempotent({ payer: plan.wallet, ata: plan.ata, owner: plan.wallet, mint: v.pool.poolMint, tokenProgram: v.pool.tokenProgramId }));
  }
  ixs.push(
    depositSol({
      programId: v.config.program,
      stakePool: v.config.stakePool,
      withdrawAuthority: v.withdrawAuthority,
      reserveStake: v.pool.reserveStake,
      from: plan.wallet,
      destination: plan.ata,
      managerFeeAccount: v.pool.managerFeeAccount,
      referrer: plan.ata,
      poolMint: v.pool.poolMint,
      tokenProgram: v.pool.tokenProgramId,
      lamports: plan.lamports,
      ...(guarded ? { minimumPoolTokensOut: plan.minPoolTokensOut } : {}),
    }),
  );
  return ixs;
}

export function buildWithdrawInstructions(plan: WithdrawPlan, compute: ComputeSettings, guarded: boolean): Instruction[] {
  const v = plan.verified;
  const ixs: Instruction[] = [
    setComputeUnitLimit(compute.unitLimit),
    setComputeUnitPrice(compute.microLamportsPerUnit),
    withdrawSol({
      programId: v.config.program,
      stakePool: v.config.stakePool,
      withdrawAuthority: v.withdrawAuthority,
      transferAuthority: plan.wallet,
      source: plan.ata,
      reserveStake: v.pool.reserveStake,
      destination: plan.wallet,
      managerFeeAccount: v.pool.managerFeeAccount,
      poolMint: v.pool.poolMint,
      tokenProgram: v.pool.tokenProgramId,
      poolTokens: plan.poolTokens,
      ...(guarded ? { minimumLamportsOut: plan.minLamportsOut } : {}),
    }),
  ];
  if (plan.closeAta) {
    ixs.push(closeTokenAccount({ account: plan.ata, destination: plan.wallet, owner: plan.wallet, tokenProgram: v.pool.tokenProgramId }));
  }
  return ixs;
}
