// Reading market conditions:
//   trend   — SOL's 1-day vs 7-day exponential moving average (hourly closes)
//   heat    — breadth of the memecoin market (share of trending tokens still rising,
//             and how many pass the momentum bot's own filters)
//   vol     — realized volatility, used to scale risk down
// and turning noisy readings into deliberate switches: a new regime must be seen
// `confirmations` times in a row; moving to a *riskier* regime also waits out a
// minimum dwell time, while moving to a safer one does not (de-risk fast, re-risk slowly).

import type { TokenInfo } from '../bot/feed.ts';
import type { BotPolicy } from '../bot/policy.ts';
import { rankCandidates } from '../bot/strategy.ts';
import { ema, realizedVolAnnualPct } from './indicators.ts';
import type { RegimeName, RouterPolicy } from './policy.ts';

export interface Signals {
  bars: number;
  at: number;
  close: number;
  emaFast: number;
  emaSlow: number;
  /** emaFast / emaSlow - 1, in percent. */
  trendPct: number;
  /** close / emaSlow - 1, in percent. */
  priceVsSlowPct: number;
  volAnnualPct: number;
}

export type Trend = 'up' | 'down' | 'range';

export function minimumBars(policy: RouterPolicy): number {
  return Math.ceil(policy.trend.slowHours * 2);
}

/** null when there is not enough history for the slow average to be meaningful. */
export function computeSignals(closes: number[], times: number[], policy: RouterPolicy): Signals | null {
  if (closes.length < minimumBars(policy) || closes.length !== times.length) return null;
  const fast = ema(closes, policy.trend.fastHours);
  const slow = ema(closes, policy.trend.slowHours);
  const i = closes.length - 1;
  const close = closes[i] as number;
  const emaFast = fast[i] as number;
  const emaSlow = slow[i] as number;
  if (!Number.isFinite(emaFast) || !Number.isFinite(emaSlow) || emaSlow <= 0) return null;
  return {
    bars: closes.length,
    at: times[i] as number,
    close,
    emaFast,
    emaSlow,
    trendPct: (emaFast / emaSlow - 1) * 100,
    priceVsSlowPct: (close / emaSlow - 1) * 100,
    volAnnualPct: realizedVolAnnualPct(closes, policy.volatility.windowHours),
  };
}

/**
 * Schmitt trigger on the EMA gap: entering a trend needs the full threshold, staying in it
 * only needs the gap to remain beyond `exitThresholdPct`. Without this, a trend hovering
 * near the threshold flips back and forth and every flip costs fees.
 */
export function classifyTrend(s: Signals, policy: RouterPolicy, current: Trend | null = null): Trend {
  const t = policy.trend;
  if (current === 'down' && s.trendPct <= -t.exitThresholdPct) return 'down';
  if (current === 'up' && s.trendPct >= t.exitThresholdPct) return 'up';
  if (s.trendPct >= t.bullThresholdPct && s.priceVsSlowPct > 0) return 'up';
  if (s.trendPct <= -t.bearThresholdPct && s.priceVsSlowPct < 0) return 'down';
  return 'range';
}

/** The trend implied by an active regime (input to the hysteresis above). */
export function trendOf(regime: RegimeName): Trend | null {
  if (regime === 'downtrend') return 'down';
  if (regime === 'uptrend' || regime === 'risk-on') return 'up';
  return regime === 'range' ? 'range' : null;
}

export interface MemeHeat {
  sampled: number;
  /** Share of the top-N trending tokens with a positive 1h change. */
  breadth: number;
  /** Tokens that pass the momentum bot's entry filters right now. */
  passing: number;
  hot: boolean;
}

export function memeHeat(tokens: TokenInfo[], botPolicy: BotPolicy, policy: RouterPolicy, nowMs: number): MemeHeat {
  const top = tokens.slice(0, policy.memeHeat.topN);
  const withChange = top.filter((t) => t.stats1h.priceChangePct !== null);
  const rising = withChange.filter((t) => (t.stats1h.priceChangePct as number) > 0).length;
  const breadth = withChange.length ? rising / withChange.length : 0;
  const passing = rankCandidates(tokens, botPolicy, nowMs, new Set()).passed.length;
  return { sampled: top.length, breadth, passing, hot: withChange.length > 0 && breadth >= policy.memeHeat.minBreadth && passing >= policy.memeHeat.minPassing };
}

export function classifyRegime(trend: Trend | null, heat: MemeHeat | null): RegimeName {
  if (trend === null) return 'unknown';
  if (trend === 'up') return heat?.hot ? 'risk-on' : 'uptrend';
  return trend === 'down' ? 'downtrend' : 'range';
}

/** Higher = more risk taken. Used for the asymmetric dwell rule. */
export const RISK_RANK: Record<RegimeName, number> = { downtrend: 0, unknown: 1, range: 1, uptrend: 2, 'risk-on': 3 };

export interface TrackerState {
  active: RegimeName;
  activeSince: number;
  pending: RegimeName | null;
  pendingCount: number;
}

export function initialTracker(nowMs: number): TrackerState {
  return { active: 'unknown', activeSince: nowMs, pending: null, pendingCount: 0 };
}

export interface TrackerUpdate {
  state: TrackerState;
  switched: boolean;
  reason: string;
}

export function updateRegime(prev: TrackerState, observed: RegimeName, nowMs: number, policy: RouterPolicy): TrackerUpdate {
  if (observed === prev.active) {
    return { state: { ...prev, pending: null, pendingCount: 0 }, switched: false, reason: `still ${prev.active}` };
  }
  const pendingCount = prev.pending === observed ? prev.pendingCount + 1 : 1;
  const pending: TrackerState = { ...prev, pending: observed, pendingCount };
  const need = policy.switching.confirmations;
  if (pendingCount < need) {
    return { state: pending, switched: false, reason: `${observed} seen ${pendingCount}/${need} times; staying ${prev.active}` };
  }
  const riskier = RISK_RANK[observed] > RISK_RANK[prev.active];
  const dwellMs = policy.switching.minDwellHours * 3_600_000;
  // Leaving the start-up "unknown" state is never held back by the dwell rule.
  if (riskier && prev.active !== 'unknown' && nowMs - prev.activeSince < dwellMs) {
    const hoursLeft = (dwellMs - (nowMs - prev.activeSince)) / 3_600_000;
    return { state: pending, switched: false, reason: `${observed} confirmed, but taking more risk waits ${hoursLeft.toFixed(1)}h more (min dwell)` };
  }
  return {
    state: { active: observed, activeSince: nowMs, pending: null, pendingCount: 0 },
    switched: true,
    reason: `switched ${prev.active} -> ${observed}`,
  };
}
