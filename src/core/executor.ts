// simulate -> firewall -> simulate final bytes -> verify predicted balances -> sign -> send -> confirm.
// Nothing is signed unless the exact bytes passed the firewall AND a simulation of
// those bytes produced the balance changes the planner predicted.

import type { Address, Signer } from '../crypto/keys.ts';
import { decodeTokenAccount } from '../solana/accounts.ts';
import { describeTransactionError } from '../solana/errors.ts';
import { RpcError, type AccountInfo, type Rpc } from '../solana/rpc.ts';
import { compileLegacyMessage, decodeLegacyMessage, signTransaction, unsignedTransaction, type CompiledMessage, type Instruction } from '../solana/tx.ts';
import { encodeBase58 } from '../util/base58.ts';
import { toBase64 } from '../util/bytes.ts';
import { formatSol } from '../util/amount.ts';
import { inspectTransaction, type FirewallReport, type FirewallRules } from './firewall.ts';
import {
  buildDepositInstructions,
  buildWithdrawInstructions,
  priorityFeeLamports,
  type ComputeSettings,
  type DepositPlan,
  type WithdrawPlan,
} from './planner.ts';
import type { Policy } from './policy.ts';
import type { PoolEvaluation, VerifiedPool } from './pools.ts';

export class ExecutionError extends Error {
  readonly logs: string[];
  constructor(message: string, logs: string[] = []) {
    super(message);
    this.name = 'ExecutionError';
    this.logs = logs;
  }
}

export interface ExecContext {
  rpc: Rpc;
  policy: Policy;
  evaluations: PoolEvaluation[];
  log: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Milliseconds clock, injectable for tests. */
  now?: () => number;
}

export interface PreparedTransaction {
  plan: DepositPlan | WithdrawPlan;
  compute: ComputeSettings;
  guarded: boolean;
  message: CompiledMessage;
  lastValidBlockHeight: bigint;
  firewall: FirewallReport;
  unitsConsumed: number | undefined;
  checks: string[];
  logs: string[];
}

const PROBE_UNIT_LIMIT = 200_000;
const MIN_UNIT_LIMIT = 20_000;
const MAX_UNIT_LIMIT = 400_000;

function verifiedPools(evaluations: PoolEvaluation[]): VerifiedPool[] {
  return evaluations.flatMap((e) => (e.verified ? [e.verified] : []));
}

export function firewallRulesFor(ctx: ExecContext, wallet: Address): FirewallRules {
  const ok = (pred: (e: PoolEvaluation) => boolean) =>
    new Set(ctx.evaluations.filter((e) => e.verified && pred(e)).map((e) => e.config.stakePool));
  return {
    wallet,
    pools: verifiedPools(ctx.evaluations),
    depositAllowed: ok((e) => e.depositable),
    withdrawAllowed: ok((e) => e.withdrawable),
    maxPriorityFeeLamports: ctx.policy.maxPriorityFeeLamports,
    maxLamportsPerTransaction: ctx.policy.maxLamportsPerTransaction,
    requireSlippageGuard: ctx.policy.requireSlippageGuardedInstructions,
  };
}

function build(plan: DepositPlan | WithdrawPlan, compute: ComputeSettings, guarded: boolean): Instruction[] {
  return plan.kind === 'deposit' ? buildDepositInstructions(plan, compute, guarded) : buildWithdrawInstructions(plan, compute, guarded);
}

/** Median-ish recent priority fee for the pool's write-locked accounts, clamped to policy. */
export async function chooseUnitPrice(rpc: Rpc, accounts: Address[], unitLimit: number, policy: Policy): Promise<bigint> {
  let price = policy.minComputeUnitPriceMicroLamports;
  try {
    const fees = (await rpc.getRecentPrioritizationFees(accounts)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (fees.length) {
      const p75 = fees[Math.floor(fees.length * 0.75)] ?? 0n;
      if (p75 > price) price = p75;
    }
  } catch {
    // Fee data is advisory; fall back to the policy minimum.
  }
  const cap = (policy.maxPriorityFeeLamports * 1_000_000n) / BigInt(unitLimit);
  return price > cap ? cap : price;
}

function tokenAmount(acc: AccountInfo | null): bigint {
  return acc ? decodeTokenAccount(acc.data).amount : 0n;
}

function verifySimulatedBalances(
  plan: DepositPlan | WithdrawPlan,
  pre: (AccountInfo | null)[],
  post: (AccountInfo | null)[],
  maxFee: bigint,
): string[] {
  const checks: string[] = [];
  const preWallet = pre[0]?.lamports ?? 0n;
  const postWallet = post[0]?.lamports ?? 0n;
  if (plan.kind === 'deposit') {
    const spent = preWallet - postWallet;
    const minSpend = plan.lamports + plan.ataRentLamports;
    if (spent < minSpend || spent > minSpend + maxFee) {
      throw new ExecutionError(`simulation: wallet would spend ${formatSol(spent)} SOL, expected ${formatSol(minSpend)} SOL plus at most ${formatSol(maxFee)} SOL fees`);
    }
    checks.push(`wallet spends ${formatSol(spent)} SOL (deposit ${formatSol(plan.lamports)} + rent ${formatSol(plan.ataRentLamports)} + fee ${formatSol(spent - minSpend)})`);
    const received = tokenAmount(post[1] ?? null) - tokenAmount(pre[1] ?? null);
    const floor = plan.minPoolTokensOut + plan.quote.referralFeeTokens;
    const tolerance = plan.receivedTokens / 10_000n + 2n; // 1 bps: other users' deposits shift rounding
    const diff = received > plan.receivedTokens ? received - plan.receivedTokens : plan.receivedTokens - received;
    if (received < floor || diff > tolerance) {
      throw new ExecutionError(`simulation: wallet would receive ${received} pool token units, quote was ${plan.receivedTokens}; pool state changed, re-run to re-plan`);
    }
    checks.push(`wallet receives ${received} ${plan.evaluation.config.symbol} units (quote ${plan.receivedTokens}, on-chain minimum ${plan.minPoolTokensOut})`);
    return checks;
  }
  const gained = postWallet - preWallet;
  const expected = plan.quote.lamportsOut + plan.ataRentLamports;
  const tolerance = plan.quote.lamportsOut / 10_000n + 2n;
  if (gained < plan.minLamportsOut + plan.ataRentLamports - maxFee || gained > expected + tolerance) {
    throw new ExecutionError(`simulation: wallet would gain ${formatSol(gained)} SOL, expected about ${formatSol(expected)} SOL less fees`);
  }
  checks.push(`wallet gains ${formatSol(gained)} SOL (redemption ${formatSol(plan.quote.lamportsOut)} + rent refund ${formatSol(plan.ataRentLamports)} − fee)`);
  const postAta = post[1] ?? null;
  if (plan.closeAta) {
    if (postAta && postAta.lamports > 0n) throw new ExecutionError('simulation: token account was expected to be closed');
    checks.push('token account closed');
  } else {
    const burned = tokenAmount(pre[1] ?? null) - tokenAmount(postAta);
    if (burned !== plan.poolTokens) throw new ExecutionError(`simulation: ${burned} pool token units would leave the account, expected ${plan.poolTokens}`);
    checks.push(`${burned} pool token units redeemed`);
  }
  return checks;
}

async function simulate(ctx: ExecContext, message: CompiledMessage, accounts: Address[]) {
  return ctx.rpc.simulateTransaction(toBase64(unsignedTransaction(message)), accounts);
}

function describe(err: unknown, message: CompiledMessage, ctx: ExecContext) {
  const programIds = decodeLegacyMessage(message.bytes).instructions.map((ix) => ix.programId as string);
  return describeTransactionError(err, (i) => programIds[i], ctx.policy.allowedStakePoolPrograms);
}

export async function prepare(ctx: ExecContext, plan: DepositPlan | WithdrawPlan): Promise<PreparedTransaction> {
  const { rpc, policy } = ctx;
  const watch: Address[] = [plan.wallet, plan.ata];
  const v = plan.verified;
  const firewallRules = firewallRulesFor(ctx, plan.wallet);

  // 1) Probe simulation to learn compute usage (and whether the guarded variant is supported).
  let guarded = true;
  const probePrice = await chooseUnitPrice(rpc, [v.config.stakePool, v.pool.reserveStake], PROBE_UNIT_LIMIT, policy);
  const { blockhash: probeHash } = await rpc.getLatestBlockhash();
  let probeMsg = compileLegacyMessage(plan.wallet, build(plan, { unitLimit: PROBE_UNIT_LIMIT, microLamportsPerUnit: probePrice }, guarded), probeHash);
  let probe = await simulate(ctx, probeMsg, watch);
  if (probe.err) {
    const d = describe(probe.err, probeMsg, ctx);
    if (d.invalidInstructionData && !policy.requireSlippageGuardedInstructions) {
      ctx.log('note: stake pool program rejected the slippage-guarded instruction; falling back to the legacy variant (policy allows it)');
      guarded = false;
      probeMsg = compileLegacyMessage(plan.wallet, build(plan, { unitLimit: PROBE_UNIT_LIMIT, microLamportsPerUnit: probePrice }, guarded), probeHash);
      probe = await simulate(ctx, probeMsg, watch);
    } else if (d.invalidInstructionData) {
      throw new ExecutionError(
        `${d.summary}. The deployed stake pool program does not accept the slippage-guarded instruction. ` +
          'Set requireSlippageGuardedInstructions=false in config/policy.json only if you accept relying on simulation alone.',
        probe.logs,
      );
    }
  }
  if (probe.err) {
    const d = describe(probe.err, probeMsg, ctx);
    throw new ExecutionError(`simulation failed: ${d.summary}${d.hint ? ` — ${d.hint}` : ''}`, probe.logs);
  }

  // 2) Final transaction with tuned compute budget.
  const units = probe.unitsConsumed ?? PROBE_UNIT_LIMIT;
  const unitLimit = Math.min(MAX_UNIT_LIMIT, Math.max(MIN_UNIT_LIMIT, Math.ceil(units * 1.25) + 5_000));
  const microLamportsPerUnit = await chooseUnitPrice(rpc, [v.config.stakePool, v.pool.reserveStake], unitLimit, policy);
  const compute: ComputeSettings = { unitLimit, microLamportsPerUnit };
  const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash();
  const message = compileLegacyMessage(plan.wallet, build(plan, compute, guarded), blockhash);

  // 3) Firewall on the exact bytes.
  const firewall = inspectTransaction(message.bytes, firewallRules);
  if (!firewall.ok) throw new ExecutionError(`transaction firewall rejected the transaction:\n  - ${firewall.violations.join('\n  - ')}`);

  // 4) Simulate the final bytes and verify the balance changes match the plan.
  const pre = await rpc.getMultipleAccounts(watch);
  const sim = await simulate(ctx, message, watch);
  if (sim.err) {
    const d = describe(sim.err, message, ctx);
    throw new ExecutionError(`final simulation failed: ${d.summary}${d.hint ? ` — ${d.hint}` : ''}`, sim.logs);
  }
  const maxFee = 5_000n + priorityFeeLamports(compute);
  const checks = verifySimulatedBalances(plan, pre, sim.accounts, maxFee);
  return { plan, compute, guarded, message, lastValidBlockHeight, firewall, unitsConsumed: sim.unitsConsumed, checks, logs: sim.logs };
}

export type SendOutcome =
  | { status: 'confirmed'; signature: string; slot: number }
  | { status: 'failed'; signature: string; error: string; logs: string[] }
  | { status: 'expired'; signature: string }
  | { status: 'unknown'; signature: string; error: string };

export async function signAndSend(ctx: ExecContext, prepared: PreparedTransaction, signer: Signer, isHalted: () => boolean): Promise<SendOutcome> {
  if (isHalted()) throw new ExecutionError('kill switch is active (HALT file or SOLPROFITS_HALT=1); refusing to sign');
  if (signer.address !== prepared.plan.wallet) throw new ExecutionError(`signing key ${signer.address} does not match wallet ${prepared.plan.wallet}`);
  // Re-check the firewall right before signing: the bytes must not have changed.
  const recheck = inspectTransaction(prepared.message.bytes, firewallRulesFor(ctx, prepared.plan.wallet));
  if (!recheck.ok) throw new ExecutionError('firewall re-check failed; refusing to sign');

  const { tx, signature: sigBytes } = signTransaction(prepared.message, [signer]);
  const signature = encodeBase58(sigBytes);
  return sendAndConfirm(ctx, toBase64(tx), signature, prepared.lastValidBlockHeight);
}

/** What sending needs: an RPC, a logger and (for tests) injectable time. */
export type SendContext = Pick<ExecContext, 'rpc' | 'log' | 'sleep' | 'now'>;

export async function sendAndConfirm(ctx: SendContext, txBase64: string, signature: string, lastValidBlockHeight: bigint): Promise<SendOutcome> {
  const { rpc } = ctx;
  const sleep = ctx.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = ctx.now ?? (() => Date.now());
  const started = now();
  const HARD_TIMEOUT_MS = 180_000;

  const send = async (): Promise<SendOutcome | null> => {
    try {
      await rpc.sendTransaction(txBase64);
    } catch (e) {
      if (e instanceof RpcError) {
        const data = e.data as { err?: unknown; logs?: string[] } | undefined;
        if (data && data.err !== undefined && data.err !== null) {
          return { status: 'failed', signature, error: `preflight: ${JSON.stringify(data.err)}`, logs: data.logs ?? [] };
        }
        if (/already been processed/i.test(e.message)) return null;
      }
      ctx.log(`send attempt failed (${(e as Error).message}); will keep polling and resend`);
    }
    return null;
  };

  const firstFailure = await send();
  if (firstFailure) return firstFailure;
  ctx.log(`sent ${signature}; waiting for confirmation…`);
  let lastSend = now();
  for (;;) {
    await sleep(2_000);
    const status = await rpc.getSignatureStatus(signature).catch(() => undefined);
    if (status) {
      if (status.err) return { status: 'failed', signature, error: JSON.stringify(status.err), logs: [] };
      if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
        return { status: 'confirmed', signature, slot: status.slot };
      }
    }
    const height = await rpc.getBlockHeight().catch(() => undefined);
    if (height !== undefined && height > lastValidBlockHeight && !status) {
      const finalCheck = await rpc.getSignatureStatus(signature).catch(() => undefined);
      if (finalCheck === null) return { status: 'expired', signature };
      if (finalCheck?.err) return { status: 'failed', signature, error: JSON.stringify(finalCheck.err), logs: [] };
      // Landed at the last moment or the status lookup failed: keep polling for confirmation.
    }
    if (now() - started > HARD_TIMEOUT_MS) {
      return { status: 'unknown', signature, error: 'could not determine the outcome within 3 minutes; check the signature in an explorer before retrying' };
    }
    if (now() - lastSend > 6_000 && (height === undefined || height <= lastValidBlockHeight)) {
      const failure = await send();
      if (failure) return failure;
      lastSend = now();
    }
  }
}
