// Risk policy: every limit the tool enforces lives here, loaded from config/policy.json.
// Unknown keys are rejected so a typo can never silently disable a guardrail.

import { toAddress, type Address } from '../crypto/keys.ts';
import { GENESIS_HASHES } from '../solana/constants.ts';
import { parseSol } from '../util/amount.ts';

export type Cluster = keyof typeof GENESIS_HASHES;

export interface Policy {
  cluster: Cluster;
  /** SOL always left liquid in the wallet to pay for future transactions (incl. an emergency exit). */
  reserveLamports: bigint;
  /** Below this, a deposit is not worth the transaction. */
  minDepositLamports: bigint;
  /** Hard cap on SOL moved by any single transaction. */
  maxLamportsPerTransaction: bigint;
  /** Tolerance between the exact quote and the on-chain enforced minimum output. */
  slippageBps: number;
  /** Max value lost on entry: (SOL deposited - SOL value of tokens received) / SOL deposited. */
  maxDepositCostBps: number;
  maxSolDepositFeeBps: number;
  /** Exit cost cap: a pool we cannot leave cheaply is not "safe". */
  maxSolWithdrawalFeeBps: number;
  /** Max share of staking rewards the pool manager keeps. */
  maxEpochFeePct: number;
  minPoolTvlLamports: bigint;
  maxPriorityFeeLamports: bigint;
  minComputeUnitPriceMicroLamports: bigint;
  /** One-epoch APY estimates above this are treated as anomalies, not opportunities. */
  aprSanityMaxPct: number;
  /** Only suggest switching pools when the estimated gain beats this (after costs). */
  switchMinAprGainPct: number;
  /** Monitor raises an alert when the wallet's total SOL value falls below this. */
  monitorMinTotalLamports: bigint | null;
  /** Refuse to fall back to instructions without an on-chain minimum-output check. */
  requireSlippageGuardedInstructions: boolean;
  allowedStakePoolPrograms: Address[];
}

export interface PoolConfig {
  symbol: string;
  name: string;
  stakePool: Address;
  mint: Address;
  program: Address;
}

type Json = Record<string, unknown>;

const POLICY_KEYS = new Set([
  '$comment',
  'cluster',
  'reserveSol',
  'minDepositSol',
  'maxSolPerTransaction',
  'slippageBps',
  'maxDepositCostBps',
  'maxSolDepositFeeBps',
  'maxSolWithdrawalFeeBps',
  'maxEpochFeePct',
  'minPoolTvlSol',
  'maxPriorityFeeSol',
  'minComputeUnitPriceMicroLamports',
  'aprSanityMaxPct',
  'switchMinAprGainPct',
  'monitorMinTotalSol',
  'requireSlippageGuardedInstructions',
  'allowedStakePoolPrograms',
]);

function num(o: Json, key: string, min: number, max: number): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    throw new Error(`policy.${key} must be a number between ${min} and ${max}`);
  }
  return v;
}

function sol(o: Json, key: string): bigint {
  const v = o[key];
  if (typeof v !== 'string') throw new Error(`policy.${key} must be a decimal string of SOL, e.g. "0.01"`);
  return parseSol(v);
}

export function parsePolicy(raw: unknown): Policy {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('policy must be a JSON object');
  const o = raw as Json;
  for (const k of Object.keys(o)) if (!POLICY_KEYS.has(k)) throw new Error(`unknown policy key "${k}"`);
  for (const k of POLICY_KEYS) if (k !== '$comment' && k !== 'monitorMinTotalSol' && !(k in o)) throw new Error(`policy.${k} is required`);

  const cluster = o.cluster;
  if (typeof cluster !== 'string' || !(cluster in GENESIS_HASHES)) throw new Error('policy.cluster must be mainnet-beta, devnet or testnet');
  if (typeof o.requireSlippageGuardedInstructions !== 'boolean') throw new Error('policy.requireSlippageGuardedInstructions must be boolean');
  if (!Array.isArray(o.allowedStakePoolPrograms) || o.allowedStakePoolPrograms.length === 0) {
    throw new Error('policy.allowedStakePoolPrograms must be a non-empty array');
  }
  const minCuPrice = o.minComputeUnitPriceMicroLamports;
  if (typeof minCuPrice !== 'number' || !Number.isSafeInteger(minCuPrice) || minCuPrice < 0) {
    throw new Error('policy.minComputeUnitPriceMicroLamports must be a non-negative integer');
  }

  const policy: Policy = {
    cluster: cluster as Cluster,
    reserveLamports: sol(o, 'reserveSol'),
    minDepositLamports: sol(o, 'minDepositSol'),
    maxLamportsPerTransaction: sol(o, 'maxSolPerTransaction'),
    slippageBps: num(o, 'slippageBps', 0, 500),
    maxDepositCostBps: num(o, 'maxDepositCostBps', 0, 500),
    maxSolDepositFeeBps: num(o, 'maxSolDepositFeeBps', 0, 500),
    maxSolWithdrawalFeeBps: num(o, 'maxSolWithdrawalFeeBps', 0, 500),
    maxEpochFeePct: num(o, 'maxEpochFeePct', 0, 50),
    minPoolTvlLamports: sol(o, 'minPoolTvlSol'),
    maxPriorityFeeLamports: sol(o, 'maxPriorityFeeSol'),
    minComputeUnitPriceMicroLamports: BigInt(minCuPrice),
    aprSanityMaxPct: num(o, 'aprSanityMaxPct', 1, 100),
    switchMinAprGainPct: num(o, 'switchMinAprGainPct', 0, 100),
    monitorMinTotalLamports: o.monitorMinTotalSol === undefined || o.monitorMinTotalSol === null ? null : sol(o, 'monitorMinTotalSol'),
    requireSlippageGuardedInstructions: o.requireSlippageGuardedInstructions,
    allowedStakePoolPrograms: o.allowedStakePoolPrograms.map((a) => toAddress(String(a))),
  };

  // Cross-field sanity: these combinations would make the guardrails meaningless.
  if (policy.reserveLamports < 5_000_000n) throw new Error('policy.reserveSol must be at least 0.005 SOL so an exit can always be paid for');
  if (policy.maxPriorityFeeLamports > 10_000_000n) throw new Error('policy.maxPriorityFeeSol above 0.01 SOL is not allowed');
  if (policy.minDepositLamports > policy.maxLamportsPerTransaction) throw new Error('policy.minDepositSol exceeds maxSolPerTransaction');
  return policy;
}

const SYMBOL_RE = /^[A-Za-z0-9]{1,16}$/;

export function parsePools(raw: unknown, policy: Policy): PoolConfig[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('pools config must be a non-empty array');
  const seen = new Set<string>();
  return raw.map((entry, i) => {
    if (!entry || typeof entry !== 'object') throw new Error(`pools[${i}] must be an object`);
    const e = entry as Json;
    const allowed = new Set(['symbol', 'name', 'stakePool', 'mint', 'program', '$comment']);
    for (const k of Object.keys(e)) if (!allowed.has(k)) throw new Error(`pools[${i}]: unknown key "${k}"`);
    const symbol = String(e.symbol ?? '');
    if (!SYMBOL_RE.test(symbol)) throw new Error(`pools[${i}].symbol is invalid`);
    if (seen.has(symbol.toLowerCase())) throw new Error(`duplicate pool symbol ${symbol}`);
    seen.add(symbol.toLowerCase());
    const program = toAddress(String(e.program));
    if (!policy.allowedStakePoolPrograms.includes(program)) {
      throw new Error(`pools[${i}] (${symbol}) uses program ${program}, which is not in policy.allowedStakePoolPrograms`);
    }
    return {
      symbol,
      name: String(e.name ?? symbol),
      stakePool: toAddress(String(e.stakePool)),
      mint: toAddress(String(e.mint)),
      program,
    };
  });
}
