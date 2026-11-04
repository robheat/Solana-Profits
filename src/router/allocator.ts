// Regime -> target weights -> concrete moves. Pure functions.

import type { RegimeName, RouterPolicy, Weights } from './policy.ts';
import type { Signals } from './regime.ts';

export function targetWeights(regime: RegimeName, policy: RouterPolicy, signals: Signals | null): { weights: Weights; notes: string[] } {
  const base = policy.profiles[policy.profile]![regime];
  const w: Weights = { ...base };
  const notes: string[] = [];
  if (signals && w.momentum > 0 && signals.volAnnualPct > policy.volatility.highAnnualPct) {
    const moved = w.momentum * (1 - policy.volatility.momentumScaleWhenHigh);
    w.momentum -= moved;
    w.stake += moved;
    notes.push(`SOL volatility ${signals.volAnnualPct.toFixed(0)}%/yr is above ${policy.volatility.highAnnualPct}%: memecoin share cut to ${(w.momentum * 100).toFixed(0)}%`);
  }
  return { weights: w, notes };
}

/** Everything valued in lamports of SOL. */
export interface Holdings {
  solLamports: bigint;
  stakeLamports: bigint;
  hedgeLamports: bigint;
  /** Raw units of the hedge token (e.g. USDC with 6 decimals). */
  hedgeUnits: bigint;
  momentumLamports: bigint;
}

export type Move =
  | { kind: 'momentum-exit' }
  | { kind: 'hedge-sell'; units: bigint; lamports: bigint }
  | { kind: 'stake-withdraw'; lamports: bigint; all: boolean }
  | { kind: 'hedge-buy'; lamports: bigint }
  | { kind: 'stake-deposit'; lamports: bigint }
  | { kind: 'momentum-budget'; lamports: bigint; allowEntries: boolean };

export interface RebalancePlan {
  totalLamports: bigint;
  investableLamports: bigint;
  targets: { stake: bigint; hedge: bigint; momentum: bigint };
  moves: Move[];
  notes: string[];
}

const share = (x: bigint, w: number): bigint => (x * BigInt(Math.round(w * 1_000_000))) / 1_000_000n;
const abs = (x: bigint): bigint => (x < 0n ? -x : x);

/**
 * Only trades when a strategy is off target by more than the band (avoids churn), never
 * below the minimum trade size, frees liquidity before funding, and never spends the
 * fee reserve or SOL earmarked for the memecoin budget.
 */
export function planRebalance(h: Holdings, w: Weights, policy: RouterPolicy): RebalancePlan {
  const notes: string[] = [];
  const total = h.solLamports + h.stakeLamports + h.hedgeLamports + h.momentumLamports;
  const investable = total > policy.feeReserveLamports ? total - policy.feeReserveLamports : 0n;
  const targets = { stake: share(investable, w.stake), hedge: share(investable, w.hedge), momentum: share(investable, w.momentum) };
  const band = share(investable, policy.rebalance.bandPct / 100);
  const minTrade = policy.rebalance.minTradeLamports;
  const moves: Move[] = [];

  if (w.momentum === 0 && h.momentumLamports > 0n && policy.momentumExitOnDisable) moves.push({ kind: 'momentum-exit' });

  // 1) Free liquidity from over-weight strategies.
  let freed = 0n;
  const hedgeDiff = targets.hedge - h.hedgeLamports;
  if (hedgeDiff < 0n && (abs(hedgeDiff) > band || targets.hedge === 0n) && abs(hedgeDiff) >= minTrade) {
    const all = targets.hedge === 0n || abs(hedgeDiff) >= h.hedgeLamports;
    const units = all ? h.hedgeUnits : (h.hedgeUnits * abs(hedgeDiff)) / (h.hedgeLamports || 1n);
    const lamports = all ? h.hedgeLamports : abs(hedgeDiff);
    if (units > 0n) {
      moves.push({ kind: 'hedge-sell', units, lamports });
      freed += lamports;
    }
  }
  const stakeDiff = targets.stake - h.stakeLamports;
  if (stakeDiff < 0n && (abs(stakeDiff) > band || targets.stake === 0n) && abs(stakeDiff) >= minTrade) {
    const all = targets.stake === 0n || abs(stakeDiff) >= h.stakeLamports;
    const lamports = all ? h.stakeLamports : abs(stakeDiff);
    moves.push({ kind: 'stake-withdraw', lamports, all });
    freed += lamports;
  }

  // 2) Fund under-weight strategies from liquid SOL, keeping the reserve and the memecoin earmark.
  const earmark = targets.momentum > h.momentumLamports ? targets.momentum - h.momentumLamports : 0n;
  let available = h.solLamports + freed - policy.feeReserveLamports - earmark;
  if (hedgeDiff > band && hedgeDiff >= minTrade && available >= minTrade) {
    const amount = hedgeDiff < available ? hedgeDiff : available;
    moves.push({ kind: 'hedge-buy', lamports: amount });
    available -= amount;
  }
  if (stakeDiff > band && stakeDiff >= minTrade && available >= minTrade) {
    const amount = stakeDiff < available ? stakeDiff : available;
    moves.push({ kind: 'stake-deposit', lamports: amount });
    available -= amount;
  }
  if (available < 0n) notes.push('liquid SOL is below the fee reserve + memecoin earmark; nothing new is funded until it recovers');

  moves.push({ kind: 'momentum-budget', lamports: targets.momentum, allowEntries: w.momentum > 0 });
  return { totalLamports: total, investableLamports: investable, targets, moves, notes };
}

export function describeMove(m: Move, fmt: (l: bigint) => string, hedgeSymbol: string): string {
  switch (m.kind) {
    case 'momentum-exit':
      return 'close all memecoin positions (strategy switched off)';
    case 'hedge-sell':
      return `sell ${hedgeSymbol} worth ${fmt(m.lamports)} SOL back to SOL`;
    case 'stake-withdraw':
      return `unstake ${m.all ? 'everything' : `${fmt(m.lamports)} SOL`} (instant withdrawal)`;
    case 'hedge-buy':
      return `swap ${fmt(m.lamports)} SOL into ${hedgeSymbol}`;
    case 'stake-deposit':
      return `stake ${fmt(m.lamports)} SOL`;
    case 'momentum-budget':
      return m.allowEntries ? `memecoin bot may hold up to ${fmt(m.lamports)} SOL` : 'memecoin bot: no new entries';
  }
}
