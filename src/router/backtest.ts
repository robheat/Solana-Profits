// Replays the router's regime detection, switching discipline and rebalancing over an
// hourly SOL/USD history and measures the result in SOL (the goal) and USD, against
// simply staking everything. The memecoin strategy cannot be replayed (no historical
// memecoin data), so its weight is treated as staked; the "risk-on" regime therefore
// never appears in a backtest. The circuit breaker is replayed too: once total value
// falls too far below the staking-only line, the rest of the test is staking only.

import { planRebalance, targetWeights, type Move } from './allocator.ts';
import type { RegimeName, RouterPolicy } from './policy.ts';
import { classifyRegime, classifyTrend, computeSignals, initialTracker, trendOf, updateRegime } from './regime.ts';
import type { PriceBar } from './prices.ts';

export interface BacktestOptions {
  startLamports: bigint;
  stakingApyPct?: number;
  swapFeeBps?: number;
  stakeExitFeeBps?: number;
  txFeeLamports?: bigint;
}

export interface BacktestResult {
  start: number;
  end: number;
  bars: number;
  startPriceUsd: number;
  endPriceUsd: number;
  finalSol: number;
  finalUsd: number;
  stakedOnlySol: number;
  stakedOnlyUsd: number;
  /** Largest peak-to-trough fall of the position measured in SOL. */
  maxDrawdownPct: number;
  stakedOnlyMaxDrawdownPct: number;
  /** The same, measured in USD (what the SOL price does to you). */
  maxDrawdownUsdPct: number;
  stakedOnlyMaxDrawdownUsdPct: number;
  switches: { t: number; from: RegimeName; to: RegimeName }[];
  moves: number;
  feesSol: number;
  hoursInRegime: Record<RegimeName, number>;
  /** When the circuit breaker tripped (staking only from then on), or null. */
  breakerTrippedAt: number | null;
}

const L = 1e9;

export function runBacktest(bars: PriceBar[], policy: RouterPolicy, opts: BacktestOptions): BacktestResult {
  if (bars.length < 2) throw new Error('backtest needs at least two price bars');
  const apy = (opts.stakingApyPct ?? policy.backtest.stakingApyPct) / 100;
  const swapFee = (opts.swapFeeBps ?? policy.backtest.swapFeeBps) / 10_000;
  const exitFee = (opts.stakeExitFeeBps ?? policy.backtest.stakeExitFeeBps) / 10_000;
  const txFee = Number(opts.txFeeLamports ?? policy.backtest.txFeeLamports) / L;
  const hourlyGrowth = Math.pow(1 + apy, 1 / (24 * 365));
  const evalEvery = Math.max(1, Math.round(policy.switching.evaluateMinutes / 60));

  // Portfolio in floating SOL / USD units (fine for a simulation; real moves use integers).
  let sol = Number(opts.startLamports) / L;
  let staked = 0;
  let usd = 0;
  let stakedOnly = Number(opts.startLamports) / L;
  let fees = 0;
  let moves = 0;
  let peak = sol;
  let maxDd = 0;
  let peakStakedOnly = stakedOnly;
  let maxDdStakedOnly = 0;
  let peakUsd = sol * bars[0]!.close;
  let maxDdUsd = 0;
  let peakStakedOnlyUsd = peakUsd;
  let maxDdStakedOnlyUsd = 0;
  let tracker = initialTracker(bars[0]!.t);
  let breakerTrippedAt: number | null = null;
  const breakerLimit = policy.circuitBreaker.maxUnderperformancePct / 100;
  const switches: BacktestResult['switches'] = [];
  const hoursInRegime: Record<RegimeName, number> = { 'risk-on': 0, uptrend: 0, range: 0, downtrend: 0, unknown: 0 };
  const closes: number[] = [];
  const times: number[] = [];

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i]!;
    const price = bar.close;
    closes.push(price);
    times.push(bar.t);
    if (i > 0) {
      staked *= hourlyGrowth;
      stakedOnly *= hourlyGrowth;
    }
    if (i % evalEvery === 0) {
      const signals = computeSignals(closes, times, policy);
      const observed = classifyRegime(signals ? classifyTrend(signals, policy, trendOf(tracker.active)) : null, null);
      const upd = updateRegime(tracker, observed, bar.t, policy);
      if (upd.switched) switches.push({ t: bar.t, from: tracker.active, to: upd.state.active });
      tracker = upd.state;
      const { weights } = targetWeights(tracker.active, policy, signals);
      if (breakerTrippedAt === null && (sol + staked + usd / price) / stakedOnly - 1 <= -breakerLimit) breakerTrippedAt = bar.t;
      // No memecoin history: its share is staked instead.
      const w = breakerTrippedAt !== null ? { stake: 1, hedge: 0, momentum: 0 } : { stake: weights.stake + weights.momentum, hedge: weights.hedge, momentum: 0 };
      const toLamports = (x: number) => BigInt(Math.max(0, Math.floor(x * L)));
      const plan = planRebalance(
        { solLamports: toLamports(sol), stakeLamports: toLamports(staked), hedgeLamports: toLamports(usd / price), hedgeUnits: toLamports(usd), momentumLamports: 0n },
        w,
        policy,
      );
      for (const m of plan.moves) apply(m, price);
    }
    hoursInRegime[tracker.active] += 1;
    const equity = sol + staked + usd / price;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, 1 - equity / peak);
    peakStakedOnly = Math.max(peakStakedOnly, stakedOnly);
    maxDdStakedOnly = Math.max(maxDdStakedOnly, 1 - stakedOnly / peakStakedOnly);
    const equityUsd = equity * price;
    const stakedOnlyUsd = stakedOnly * price;
    peakUsd = Math.max(peakUsd, equityUsd);
    maxDdUsd = Math.max(maxDdUsd, 1 - equityUsd / peakUsd);
    peakStakedOnlyUsd = Math.max(peakStakedOnlyUsd, stakedOnlyUsd);
    maxDdStakedOnlyUsd = Math.max(maxDdStakedOnlyUsd, 1 - stakedOnlyUsd / peakStakedOnlyUsd);
  }

  function apply(m: Move, price: number): void {
    switch (m.kind) {
      case 'stake-deposit': {
        const x = Number(m.lamports) / L;
        sol -= x + txFee;
        staked += x;
        fees += txFee;
        moves++;
        return;
      }
      case 'stake-withdraw': {
        const x = Math.min(staked, Number(m.lamports) / L);
        staked -= x;
        sol += x * (1 - exitFee) - txFee;
        fees += x * exitFee + txFee;
        moves++;
        return;
      }
      case 'hedge-buy': {
        const x = Number(m.lamports) / L;
        sol -= x + txFee;
        usd += x * price * (1 - swapFee);
        fees += x * swapFee + txFee;
        moves++;
        return;
      }
      case 'hedge-sell': {
        const units = Math.min(usd, Number(m.units) / L);
        usd -= units;
        sol += (units / price) * (1 - swapFee) - txFee;
        fees += (units / price) * swapFee + txFee;
        moves++;
        return;
      }
      default:
        return;
    }
  }

  const last = bars[bars.length - 1]!;
  const finalSol = sol + staked + usd / last.close;
  return {
    start: bars[0]!.t,
    end: last.t,
    bars: bars.length,
    startPriceUsd: bars[0]!.close,
    endPriceUsd: last.close,
    finalSol,
    finalUsd: finalSol * last.close,
    stakedOnlySol: stakedOnly,
    stakedOnlyUsd: stakedOnly * last.close,
    maxDrawdownPct: maxDd * 100,
    stakedOnlyMaxDrawdownPct: maxDdStakedOnly * 100,
    maxDrawdownUsdPct: maxDdUsd * 100,
    stakedOnlyMaxDrawdownUsdPct: maxDdStakedOnlyUsd * 100,
    switches,
    moves,
    feesSol: fees,
    hoursInRegime,
    breakerTrippedAt,
  };
}
