// Exact mirrors of the spl-stake-pool program's integer math (state.rs / processor.rs,
// v2.2.0), so the tool knows *precisely* what a deposit or withdrawal will produce
// before it signs anything. Rounding directions match the program: fees round up,
// conversions round down.

import type { Fee, StakePool } from '../solana/accounts.ts';
import { U64_MAX } from '../util/bytes.ts';

export class CalculationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalculationError';
  }
}

function toU64(v: bigint, what: string): bigint {
  if (v < 0n || v > U64_MAX) throw new CalculationError(`${what} does not fit in u64`);
  return v;
}

/** Fee::apply — ceil(amount * numerator / denominator); zero when denominator is zero. */
export function applyFee(fee: Fee, amount: bigint): bigint {
  if (fee.denominator === 0n) return 0n;
  return (amount * fee.numerator + fee.denominator - 1n) / fee.denominator;
}

export function feeRatio(fee: Fee): number {
  if (fee.denominator === 0n || fee.numerator === 0n) return 0;
  return Number(fee.numerator) / Number(fee.denominator);
}

export function feeBps(fee: Fee): number {
  return feeRatio(fee) * 10_000;
}

export function calcPoolTokensForDeposit(pool: StakePool, lamports: bigint): bigint {
  if (pool.totalLamports === 0n || pool.poolTokenSupply === 0n) return lamports;
  return toU64((lamports * pool.poolTokenSupply) / pool.totalLamports, 'pool tokens for deposit');
}

export function calcLamportsWithdrawAmount(pool: StakePool, poolTokens: bigint): bigint {
  const numerator = poolTokens * pool.totalLamports;
  const denominator = pool.poolTokenSupply;
  if (numerator < denominator || denominator === 0n) return 0n;
  return toU64(numerator / denominator, 'withdraw lamports');
}

export interface DepositSolQuote {
  lamportsIn: bigint;
  newPoolTokens: bigint;
  depositFeeTokens: bigint;
  referralFeeTokens: bigint;
  managerFeeTokens: bigint;
  /** Tokens minted to the depositor's destination account. */
  userTokens: bigint;
}

/** process_deposit_sol */
export function quoteDepositSol(pool: StakePool, lamportsIn: bigint): DepositSolQuote {
  const newPoolTokens = calcPoolTokensForDeposit(pool, lamportsIn);
  const depositFeeTokens = toU64(applyFee(pool.solDepositFee, newPoolTokens), 'sol deposit fee');
  if (depositFeeTokens > newPoolTokens) throw new CalculationError('deposit fee exceeds minted tokens');
  const userTokens = newPoolTokens - depositFeeTokens;
  const referralFeeTokens = toU64((depositFeeTokens * BigInt(pool.solReferralFee)) / 100n, 'referral fee');
  const managerFeeTokens = depositFeeTokens - referralFeeTokens;
  if (userTokens === 0n) throw new CalculationError('DepositTooSmall: deposit would mint zero pool tokens');
  return { lamportsIn, newPoolTokens, depositFeeTokens, referralFeeTokens, managerFeeTokens, userTokens };
}

export interface WithdrawSolQuote {
  poolTokensIn: bigint;
  feeTokens: bigint;
  burnedTokens: bigint;
  lamportsOut: bigint;
}

/** process_withdraw_sol (assuming a valid manager fee account, i.e. the fee is charged). */
export function quoteWithdrawSol(pool: StakePool, poolTokensIn: bigint): WithdrawSolQuote {
  const feeTokens = toU64(applyFee(pool.solWithdrawalFee, poolTokensIn), 'sol withdrawal fee');
  if (feeTokens > poolTokensIn) throw new CalculationError('withdrawal fee exceeds pool tokens');
  const burnedTokens = poolTokensIn - feeTokens;
  const lamportsOut = calcLamportsWithdrawAmount(pool, burnedTokens);
  if (lamportsOut === 0n) throw new CalculationError('WithdrawalTooSmall: withdrawal would return zero lamports');
  return { poolTokensIn, feeTokens, burnedTokens, lamportsOut };
}

/** Value of pool tokens in lamports at the current pool rate (what a fee-free redemption would pay). */
export function poolTokensToLamports(pool: StakePool, poolTokens: bigint): bigint {
  return calcLamportsWithdrawAmount(pool, poolTokens);
}

/** Lamports per pool token as a float, for display and ranking only. */
export function exchangeRate(pool: StakePool): number {
  if (pool.poolTokenSupply === 0n) return 1;
  return Number((pool.totalLamports * 1_000_000_000n) / pool.poolTokenSupply) / 1e9;
}

/**
 * Growth of the pool's lamports-per-token since the previous epoch update
 * (fields documented on-chain as "used only for APR estimation"). Returns the
 * ratio new/old - 1, or null when there is no previous data point.
 */
export function lastEpochReturn(pool: StakePool): number | null {
  const { totalLamports: tl1, poolTokenSupply: ps1, lastEpochTotalLamports: tl0, lastEpochPoolTokenSupply: ps0 } = pool;
  if (tl0 === 0n || ps0 === 0n || ps1 === 0n) return null;
  // (tl1/ps1) / (tl0/ps0) - 1 = (tl1*ps0 - tl0*ps1) / (tl0*ps1); keep it exact until the final division.
  const num = tl1 * ps0 - tl0 * ps1;
  const den = tl0 * ps1;
  const SCALE = 10n ** 18n;
  return Number((num * SCALE) / den) / 1e18;
}

export function annualize(perEpochReturn: number, epochsPerYear: number): number {
  return Math.pow(1 + perEpochReturn, epochsPerYear) - 1;
}
