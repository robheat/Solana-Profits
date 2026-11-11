// The strategy router: read market conditions -> confirm the regime -> target weights ->
// rebalance through the guarded executors. Bad or stale data means no decision at all,
// and a portfolio-level circuit breaker returns everything to staking when the active
// strategies have cost too much against simply staking.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TokenFeed } from '../bot/feed.ts';
import { WSOL_MINT } from '../bot/jupiter.ts';
import type { BotPolicy } from '../bot/policy.ts';
import type { BotState } from '../bot/state.ts';
import { rankPools, type VerifiedPool } from '../core/pools.ts';
import { planRebalance, targetWeights, type Move, type PlanOptions, type RebalancePlan } from './allocator.ts';
import type { RegimeName, RouterPolicy, Weights } from './policy.ts';
import type { PriceBar } from './prices.ts';
import {
  classifyRegime,
  classifyTrend,
  computeSignals,
  initialTracker,
  memeHeat,
  minimumBars,
  trendOf,
  updateRegime,
  type MemeHeat,
  type Signals,
  type TrackerState,
  type TrackerUpdate,
  type Trend,
} from './regime.ts';
import { executeMove, takeSnapshot, type MoveResult, type SleeveDeps, type Snapshot } from './sleeves.ts';

export interface PriceSource {
  /** Hourly SOL/USD closes covering at least the last `hours` hours before `nowMs`. */
  history(nowMs: number, hours: number): Promise<PriceBar[]>;
}

/** Where performance tracking started: the wallet's value and the staking pool's exchange rate then. */
export interface Baseline {
  at: number;
  totalLamports: string;
  /** Pool whose exchange rate defines "what staking alone would have earned". */
  pool: string;
  poolLamports: string;
  poolTokens: string;
}

export interface Performance {
  at: number;
  totalLamports: bigint;
  /** What the starting balance would be worth now if it had simply been staked. */
  benchmarkLamports: bigint;
  /** total / benchmark - 1, in percent. */
  relativePct: number;
}

export interface RouterState {
  version: 1;
  wallet: string;
  tracker: TrackerState;
  /** Last evaluation with trustworthy data. */
  lastEvaluatedAt: number;
  lastObserved: RegimeName | null;
  switches: { t: number; from: RegimeName; to: RegimeName }[];
  momentum: { allowEntries: boolean; maxExposureLamports: string };
  baseline: Baseline | null;
  performance: { at: number; totalLamports: string; benchmarkLamports: string; relativePct: number } | null;
  /** Set when the circuit breaker has tripped; cleared only by `auto resume`. */
  breaker: { trippedAt: number; relativePct: number } | null;
}

export class RouterStore {
  readonly path: string;
  constructor(path: string) {
    this.path = path;
  }
  exists(): boolean {
    return existsSync(this.path);
  }
  load(wallet: string, nowMs: number): RouterState {
    if (!existsSync(this.path)) {
      return {
        version: 1,
        wallet,
        tracker: initialTracker(nowMs),
        lastEvaluatedAt: 0,
        lastObserved: null,
        switches: [],
        momentum: { allowEntries: false, maxExposureLamports: '0' },
        baseline: null,
        performance: null,
        breaker: null,
      };
    }
    const s = JSON.parse(readFileSync(this.path, 'utf8')) as RouterState;
    if (s.version !== 1) throw new Error(`unsupported router state version in ${this.path}`);
    if (s.wallet !== wallet) throw new Error(`${this.path} belongs to wallet ${s.wallet}`);
    // Fields added after the first release of this file format.
    s.baseline ??= null;
    s.performance ??= null;
    s.breaker ??= null;
    return s;
  }
  save(s: RouterState): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeFileSync(`${this.path}.tmp`, JSON.stringify(s, null, 2), { mode: 0o600 });
    renameSync(`${this.path}.tmp`, this.path);
  }
}

/** Clears the circuit breaker and restarts performance tracking from the next evaluation. */
export function resumeState(s: RouterState): RouterState {
  s.breaker = null;
  s.baseline = null;
  s.performance = null;
  return s;
}

export interface EquityEntry {
  ts: string;
  regime: RegimeName;
  totalLamports: string;
  benchmarkLamports: string | null;
  relativePct: number | null;
  solLamports: string;
  stakeLamports: string;
  hedgeLamports: string;
  momentumLamports: string;
  solUsd: number | null;
  breaker: boolean;
}

export interface RouterDeps {
  sleeves: SleeveDeps;
  policy: RouterPolicy;
  botPolicy: BotPolicy;
  prices: PriceSource;
  /** null disables the meme-heat reading (then "risk-on" is never observed). */
  feed: TokenFeed | null;
  store: RouterStore;
  momentumState: () => BotState | null;
  /** Sells all memecoin positions (used when the strategy is switched off and policy says exit). */
  momentumExit?: () => Promise<string>;
  /** Called once per committed evaluation with trustworthy data. */
  equityLog?: (entry: EquityEntry) => void;
  now: () => number;
}

export interface Evaluation {
  at: number;
  signals: Signals | null;
  heat: MemeHeat | null;
  trend: Trend | null;
  observed: RegimeName;
  /** Set when the data cannot be trusted: no regime update and no trades. */
  dataIssue: string | null;
  update: TrackerUpdate | null;
  regime: RegimeName;
  weights: Weights;
  notes: string[];
  snapshot: Snapshot;
  /** SOL value of everything the wallet holds, including refundable account rent. */
  totalLamports: bigint;
  performance: Performance | null;
  /** The circuit breaker is in force for this evaluation (already tripped, or tripping now). */
  breakerActive: boolean;
  breakerTripped: boolean;
  planOptions: PlanOptions;
  plan: RebalancePlan;
}

export interface StepReport {
  evaluation: Evaluation;
  results: { move: Move; result: MoveResult }[];
  state: RouterState;
}

const TRADE_KINDS = new Set<Move['kind']>(['momentum-exit', 'hedge-sell', 'stake-withdraw', 'hedge-buy', 'stake-deposit']);
const STAKE_ONLY: Weights = { stake: 1, hedge: 0, momentum: 0 };

/** The pool that stands for "just stake it": the one held, else the one a deposit would pick. */
function benchmarkPool(snapshot: Snapshot, symbol?: string): VerifiedPool | null {
  if (symbol) return snapshot.evaluations.find((e) => e.config.symbol === symbol)?.verified ?? null;
  const held = snapshot.portfolio.positions.filter((p) => p.tokens > 0n && p.evaluation.verified).sort((a, b) => (b.valueLamports > a.valueLamports ? 1 : -1))[0];
  if (held) return held.evaluation.verified;
  const ranked = rankPools(snapshot.evaluations).find((e) => e.verified && e.depositable) ?? snapshot.evaluations.find((e) => e.verified);
  return ranked?.verified ?? null;
}

export class Router {
  private readonly d: RouterDeps;
  constructor(d: RouterDeps) {
    this.d = d;
  }

  state(): RouterState {
    return this.d.store.load(this.d.sleeves.wallet, this.d.now());
  }

  async evaluate(state: RouterState): Promise<Evaluation> {
    const { policy, sleeves } = this.d;
    const now = this.d.now();
    const notes: string[] = [];
    let dataIssue: string | null = null;

    const bars = await this.d.prices.history(now, minimumBars(policy) + 48);
    const last = bars[bars.length - 1];
    const signals = computeSignals(bars.map((b) => b.close), bars.map((b) => b.t), policy);
    if (!last) dataIssue = 'no price history';
    else if (now - last.t > policy.dataCheck.maxStalenessMinutes * 60_000) dataIssue = `price history is stale (last bar ${new Date(last.t).toISOString()})`;
    if (!dataIssue && signals) {
      // Cross-check the history's latest close against what the market would actually pay.
      try {
        const q = await sleeves.jupiter.quote({ inputMint: WSOL_MINT, outputMint: policy.hedge.mint, amount: 1_000_000_000n, slippageBps: policy.hedge.slippageBps });
        const spot = Number(q.outAmount) / 10 ** policy.hedge.decimals;
        const gap = (Math.abs(spot - signals.close) / spot) * 100;
        if (gap > policy.dataCheck.maxPriceDisagreementPct) {
          dataIssue = `price history (${signals.close.toFixed(2)}) and live quote (${spot.toFixed(2)}) disagree by ${gap.toFixed(1)}%`;
        }
      } catch (e) {
        dataIssue = `could not cross-check the price: ${(e as Error).message}`;
      }
    }

    let heat: MemeHeat | null = null;
    if (this.d.feed) {
      try {
        heat = memeHeat(await this.d.feed.trending(), this.d.botPolicy, policy, now);
      } catch (e) {
        notes.push(`memecoin market reading unavailable (${(e as Error).message}); "risk-on" cannot be confirmed`);
      }
    }

    // Confirmations must be consecutive readings: after a long gap the count starts over.
    let tracker = state.tracker;
    const maxGapMs = policy.switching.evaluateMinutes * 60_000 * 3;
    if (tracker.pending && state.lastEvaluatedAt > 0 && now - state.lastEvaluatedAt > maxGapMs) {
      notes.push(`last reading was ${((now - state.lastEvaluatedAt) / 3_600_000).toFixed(1)}h ago: the pending switch to ${tracker.pending} starts its confirmations over`);
      tracker = { ...tracker, pending: null, pendingCount: 0 };
    }
    const trend = signals ? classifyTrend(signals, policy, trendOf(tracker.active)) : null;
    const observed = classifyRegime(trend, heat);
    const update = dataIssue ? null : updateRegime(tracker, observed, now, policy);
    const regime = update ? update.state.active : tracker.active;
    if (!signals) notes.push(`need ${minimumBars(policy)} hourly bars of price history, have ${bars.length}: staying in the "unknown" allocation`);

    const snapshot = await takeSnapshot(sleeves, this.d.momentumState());
    const h = snapshot.holdings;
    const totalLamports = h.solLamports + h.stakeLamports + h.hedgeLamports + h.momentumLamports + snapshot.lockedRentLamports;

    // Performance against simply staking the starting balance.
    let performance: Performance | null = null;
    if (state.baseline) {
      const v = benchmarkPool(snapshot, state.baseline.pool);
      const baseTokens = BigInt(state.baseline.poolTokens);
      const baseLamports = BigInt(state.baseline.poolLamports);
      if (v && v.pool.poolTokenSupply > 0n && baseLamports > 0n) {
        const benchmarkLamports = (BigInt(state.baseline.totalLamports) * v.pool.totalLamports * baseTokens) / (v.pool.poolTokenSupply * baseLamports);
        if (benchmarkLamports > 0n) {
          performance = { at: now, totalLamports, benchmarkLamports, relativePct: (Number(totalLamports) / Number(benchmarkLamports) - 1) * 100 };
        }
      } else {
        notes.push(`benchmark pool ${state.baseline.pool} could not be read: performance tracking and the circuit breaker are paused`);
      }
    }
    const limit = policy.circuitBreaker.maxUnderperformancePct;
    const breakerTripped = !state.breaker && !dataIssue && performance !== null && performance.relativePct <= -limit;
    const breakerActive = state.breaker !== null || breakerTripped;

    let weights: Weights;
    if (breakerActive) {
      weights = STAKE_ONLY;
      notes.push(
        breakerTripped
          ? `CIRCUIT BREAKER TRIPPED: total value is ${Math.abs(performance!.relativePct).toFixed(1)}% below the staking-only benchmark (limit ${limit}%). Returning to staking only until "auto resume".`
          : 'circuit breaker is active: staking only, whatever the market regime, until "auto resume"',
      );
    } else {
      const tw = targetWeights(regime, policy, signals);
      weights = tw.weights;
      notes.push(...tw.notes);
    }
    const planOptions: PlanOptions = { minStakeDepositLamports: sleeves.cfg.policy.minDepositLamports, ...(breakerActive ? { forceMomentumExit: true } : {}) };
    const plan = planRebalance(h, weights, policy, planOptions);
    notes.push(...plan.notes);
    return { at: now, signals, heat, trend, observed, dataIssue, update, regime, weights, notes, snapshot, totalLamports, performance, breakerActive, breakerTripped, planOptions, plan };
  }

  /**
   * One decision cycle. With a signer, executes the moves one at a time, re-reading the
   * wallet between moves; without one, simulates only the first move (later moves depend
   * on it) and changes nothing on-chain. State only advances when `commit`.
   */
  async step(opts: { commit: boolean }): Promise<StepReport> {
    const state = this.state();
    const evaluation = await this.evaluate(state);
    const results: StepReport['results'] = [];
    const live = this.d.sleeves.signer !== null;

    if (opts.commit && !evaluation.dataIssue) {
      if (evaluation.update) {
        if (evaluation.update.switched) {
          state.switches.push({ t: evaluation.at, from: state.tracker.active, to: evaluation.update.state.active });
          if (state.switches.length > 200) state.switches.splice(0, state.switches.length - 200);
        }
        state.tracker = evaluation.update.state;
      }
      state.lastEvaluatedAt = evaluation.at;
      state.lastObserved = evaluation.observed;
      if (!state.baseline) {
        const v = benchmarkPool(evaluation.snapshot);
        if (v && v.pool.poolTokenSupply > 0n && v.pool.totalLamports > 0n) {
          state.baseline = {
            at: evaluation.at,
            totalLamports: evaluation.totalLamports.toString(),
            pool: v.config.symbol,
            poolLamports: v.pool.totalLamports.toString(),
            poolTokens: v.pool.poolTokenSupply.toString(),
          };
        }
      }
      const perf = evaluation.performance;
      if (perf) state.performance = { at: perf.at, totalLamports: perf.totalLamports.toString(), benchmarkLamports: perf.benchmarkLamports.toString(), relativePct: perf.relativePct };
      if (evaluation.breakerTripped && perf) state.breaker = { trippedAt: evaluation.at, relativePct: perf.relativePct };
      const h = evaluation.snapshot.holdings;
      this.d.equityLog?.({
        ts: new Date(evaluation.at).toISOString(),
        regime: evaluation.regime,
        totalLamports: evaluation.totalLamports.toString(),
        benchmarkLamports: perf ? perf.benchmarkLamports.toString() : null,
        relativePct: perf ? perf.relativePct : null,
        solLamports: h.solLamports.toString(),
        stakeLamports: h.stakeLamports.toString(),
        hedgeLamports: h.hedgeLamports.toString(),
        momentumLamports: h.momentumLamports.toString(),
        solUsd: evaluation.signals?.close ?? null,
        breaker: evaluation.breakerActive,
      });
    }

    if (!evaluation.dataIssue) {
      const budget = evaluation.plan.moves.find((m) => m.kind === 'momentum-budget');
      if (budget && budget.kind === 'momentum-budget' && opts.commit) {
        state.momentum = { allowEntries: budget.allowEntries, maxExposureLamports: budget.lamports.toString() };
      }
      let plan = evaluation.plan;
      let snapshot = evaluation.snapshot;
      for (let i = 0; i < 5; i++) {
        const move = plan.moves.find((m) => TRADE_KINDS.has(m.kind));
        if (!move) break;
        let result: MoveResult;
        if (move.kind === 'momentum-exit') {
          if (!live || !this.d.momentumExit) {
            results.push({ move, result: { ok: true, status: live ? 'skipped' : 'simulated', detail: 'memecoin positions would be sold' } });
            if (!live) break;
            plan = { ...plan, moves: plan.moves.filter((m) => m !== move) };
            continue;
          }
          try {
            result = { ok: true, status: 'confirmed', detail: await this.d.momentumExit() };
          } catch (e) {
            result = { ok: false, status: 'refused', detail: (e as Error).message };
          }
        } else {
          try {
            result = await executeMove(this.d.sleeves, snapshot, move);
          } catch (e) {
            result = { ok: false, status: 'refused', detail: (e as Error).message };
          }
        }
        results.push({ move, result });
        if (!live || !result.ok) break;
        snapshot = await takeSnapshot(this.d.sleeves, this.d.momentumState());
        plan = planRebalance(snapshot.holdings, evaluation.weights, this.d.policy, evaluation.planOptions);
      }
    }
    if (opts.commit) this.d.store.save(state);
    return { evaluation, results, state };
  }
}
