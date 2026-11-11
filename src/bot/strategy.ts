// Momentum strategy rules. Pure functions: no I/O, fully unit-tested.
//
// Entry: tokens trending in the last hour that are liquid, widely held, organically
// traded, old enough not to be a fresh launch, still rising, with more buying than
// selling. Exit: half at +100% (the target; this recovers the cost basis), trail the
// rest; stop-loss before that; time stop if nothing happens.
// No claim of positive expected value is made — see docs/MEMECOIN_BOT.md.

import type { TokenInfo } from './feed.ts';
import type { BotPolicy } from './policy.ts';

export function screenToken(t: TokenInfo, policy: BotPolicy, nowMs: number): string[] {
  const f = policy.filters;
  const r: string[] = [];
  const need = (v: number | null, label: string): v is number => {
    if (v === null) {
      r.push(`no ${label} data`);
      return false;
    }
    return true;
  };
  if (need(t.liquidityUsd, 'liquidity') && t.liquidityUsd < f.minLiquidityUsd) r.push(`liquidity $${Math.round(t.liquidityUsd)} < $${f.minLiquidityUsd}`);
  if (need(t.mcapUsd, 'market cap') && (t.mcapUsd < f.minMarketCapUsd || t.mcapUsd > f.maxMarketCapUsd)) r.push(`market cap $${Math.round(t.mcapUsd)} outside [$${f.minMarketCapUsd}, $${f.maxMarketCapUsd}]`);
  if (need(t.holderCount, 'holder count') && t.holderCount < f.minHolderCount) r.push(`${t.holderCount} holders < ${f.minHolderCount}`);
  if (need(t.topHoldersPct, 'top-holder') && t.topHoldersPct > f.maxTopHoldersPct) r.push(`top holders own ${t.topHoldersPct.toFixed(1)}% > ${f.maxTopHoldersPct}%`);
  if (t.devBalancePct !== null && t.devBalancePct > f.maxDevBalancePct) r.push(`developer holds ${t.devBalancePct.toFixed(1)}% > ${f.maxDevBalancePct}%`);
  if (need(t.organicScore, 'organic score') && t.organicScore < f.minOrganicScore) r.push(`organic score ${t.organicScore.toFixed(0)} < ${f.minOrganicScore} (likely bot/wash volume)`);
  if (t.mintAuthorityDisabled === false) r.push('feed reports an active mint authority');
  if (t.freezeAuthorityDisabled === false) r.push('feed reports an active freeze authority');
  if (need(t.firstPoolAt, 'pool age')) {
    const ageHours = (nowMs - t.firstPoolAt) / 3_600_000;
    if (ageHours < f.minAgeHours) r.push(`only ${ageHours.toFixed(1)}h old < ${f.minAgeHours}h (fresh launches rug most)`);
    if (ageHours > f.maxAgeDays * 24) r.push(`older than ${f.maxAgeDays} days`);
  }
  const h1 = t.stats1h;
  if (need(h1.priceChangePct, '1h price change')) {
    if (h1.priceChangePct < f.min1hPriceChangePct) r.push(`1h change ${h1.priceChangePct.toFixed(1)}% < ${f.min1hPriceChangePct}%`);
    if (h1.priceChangePct > f.max1hPriceChangePct) r.push(`1h change ${h1.priceChangePct.toFixed(1)}% > ${f.max1hPriceChangePct}% (blow-off top)`);
  }
  if (need(t.stats5m.priceChangePct, '5m price change') && t.stats5m.priceChangePct < f.min5mPriceChangePct) r.push(`5m change ${t.stats5m.priceChangePct.toFixed(1)}% < ${f.min5mPriceChangePct}% (momentum fading)`);
  const buys = h1.buyVolumeUsd;
  const sells = h1.sellVolumeUsd;
  if (need(buys, '1h buy volume') && need(sells, '1h sell volume')) {
    if (buys + sells < f.min1hVolumeUsd) r.push(`1h volume $${Math.round(buys + sells)} < $${f.min1hVolumeUsd}`);
    const ratio = sells > 0 ? buys / sells : Infinity;
    if (ratio < f.minBuySellRatio1h) r.push(`1h buy/sell ratio ${ratio.toFixed(2)} < ${f.minBuySellRatio1h}`);
  }
  return r;
}

/** Higher is better: momentum, damped above +100%, weighted by organic trading and buy pressure. */
export function scoreToken(t: TokenInfo): number {
  const change = Math.min(t.stats1h.priceChangePct ?? 0, 100) / 100;
  const organic = (t.organicScore ?? 0) / 100;
  const buys = t.stats1h.buyVolumeUsd ?? 0;
  const sells = t.stats1h.sellVolumeUsd ?? 0;
  const pressure = Math.min(sells > 0 ? buys / sells : 3, 3);
  return change * organic * pressure;
}

export function rankCandidates(tokens: TokenInfo[], policy: BotPolicy, nowMs: number, exclude: Set<string>): { passed: TokenInfo[]; rejected: { token: TokenInfo; reasons: string[] }[] } {
  const passed: TokenInfo[] = [];
  const rejected: { token: TokenInfo; reasons: string[] }[] = [];
  for (const t of tokens) {
    if (exclude.has(t.mint)) {
      rejected.push({ token: t, reasons: ['held, cooling down, or recently rejected'] });
      continue;
    }
    const reasons = screenToken(t, policy, nowMs);
    if (reasons.length) rejected.push({ token: t, reasons });
    else passed.push(t);
  }
  passed.sort((a, b) => scoreToken(b) - scoreToken(a));
  return { passed, rejected };
}

export const ESTIMATED_TX_FEE_LAMPORTS = 5_000n;

/** Set by the strategy router: the most the bot may hold in total, and what it holds now. */
export interface SizingBudget {
  maxExposureLamports: bigint;
  exposureLamports: bigint;
}

/**
 * Size of the next position, or null with a reason. Never touches the fee reserve.
 * Standalone, a position is a share of the wallet's equity and an equity floor applies.
 * Under a router budget, a position is a share of that budget instead (at least the
 * minimum size, never more than the room left); the floor does not apply because the
 * router caps the exposure and has its own portfolio-level stop.
 */
export function positionSize(p: {
  equityLamports: bigint;
  solLamports: bigint;
  openPositions: number;
  policy: BotPolicy;
  rentLamports: bigint;
  budget?: SizingBudget;
}): { lamports: bigint } | { lamports: null; reason: string } {
  const { policy, budget } = p;
  if (p.openPositions >= policy.maxOpenPositions) return { lamports: null, reason: `already holding ${p.openPositions}/${policy.maxOpenPositions} positions` };
  const fraction = BigInt(Math.round(policy.positionFraction * 10_000));
  const available = p.solLamports - policy.feeReserveLamports - p.rentLamports - policy.maxPriorityFeeLamports - ESTIMATED_TX_FEE_LAMPORTS;
  let size: bigint;
  if (budget) {
    const room = budget.maxExposureLamports - budget.exposureLamports;
    size = (budget.maxExposureLamports * fraction) / 10_000n;
    if (size < policy.minPositionLamports) size = policy.minPositionLamports;
    if (room < size) size = room;
    if (size < policy.minPositionLamports) return { lamports: null, reason: 'the memecoin budget leaves no room for a minimum-size position' };
  } else {
    if (p.equityLamports < policy.equityFloorLamports) return { lamports: null, reason: 'equity is below the floor: no new positions' };
    size = (p.equityLamports * fraction) / 10_000n;
  }
  if (available < size) size = available;
  if (size < policy.minPositionLamports) return { lamports: null, reason: 'not enough free SOL for a minimum-size position' };
  return { lamports: size };
}

export interface PositionView {
  openedAt: number;
  costLamports: bigint;
  realizedLamports: bigint;
  peakValueLamports: bigint;
  takeProfitDone: boolean;
}

export type ExitReason = 'take-profit' | 'trailing-stop' | 'stop-loss' | 'time-stop';
export type ExitDecision = { action: 'hold' } | { action: 'sell'; fraction: number; reason: ExitReason; slippageBps: number };

/** `valueLamports` is the executable SOL value of the remaining tokens (a sell quote). */
export function decideExit(pos: PositionView, valueLamports: bigint, nowMs: number, policy: BotPolicy): ExitDecision {
  const cost = Number(pos.costLamports);
  const value = Number(valueLamports);
  if (!pos.takeProfitDone) {
    if (value <= cost * (1 - policy.stopLossPct / 100)) return { action: 'sell', fraction: 1, reason: 'stop-loss', slippageBps: policy.emergencySlippageBps };
    if (value >= cost * (1 + policy.takeProfitPct / 100)) return { action: 'sell', fraction: policy.takeProfitSellFraction, reason: 'take-profit', slippageBps: policy.sellSlippageBps };
  } else {
    const peak = Number(pos.peakValueLamports > valueLamports ? pos.peakValueLamports : valueLamports);
    if (value <= peak * (1 - policy.trailingStopPct / 100)) return { action: 'sell', fraction: 1, reason: 'trailing-stop', slippageBps: policy.emergencySlippageBps };
  }
  if (nowMs - pos.openedAt >= policy.maxHoldHours * 3_600_000) return { action: 'sell', fraction: 1, reason: 'time-stop', slippageBps: policy.sellSlippageBps };
  return { action: 'hold' };
}
