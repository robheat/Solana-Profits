// The strategy router: read market conditions -> confirm the regime -> target weights ->
// rebalance through the guarded executors. Bad or stale data means no decision at all.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TokenFeed } from '../bot/feed.ts';
import { WSOL_MINT } from '../bot/jupiter.ts';
import type { BotPolicy } from '../bot/policy.ts';
import type { BotState } from '../bot/state.ts';
import { planRebalance, targetWeights, type Move, type RebalancePlan } from './allocator.ts';
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

export interface RouterState {
  version: 1;
  wallet: string;
  tracker: TrackerState;
  lastEvaluatedAt: number;
  lastObserved: RegimeName | null;
  switches: { t: number; from: RegimeName; to: RegimeName }[];
  momentum: { allowEntries: boolean; maxExposureLamports: string };
}

export class RouterStore {
  readonly path: string;
  constructor(path: string) {
    this.path = path;
  }
  load(wallet: string, nowMs: number): RouterState {
    if (!existsSync(this.path)) {
      return { version: 1, wallet, tracker: initialTracker(nowMs), lastEvaluatedAt: 0, lastObserved: null, switches: [], momentum: { allowEntries: false, maxExposureLamports: '0' } };
    }
    const s = JSON.parse(readFileSync(this.path, 'utf8')) as RouterState;
    if (s.version !== 1) throw new Error(`unsupported router state version in ${this.path}`);
    if (s.wallet !== wallet) throw new Error(`${this.path} belongs to wallet ${s.wallet}`);
    return s;
  }
  save(s: RouterState): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeFileSync(`${this.path}.tmp`, JSON.stringify(s, null, 2), { mode: 0o600 });
    renameSync(`${this.path}.tmp`, this.path);
  }
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
  plan: RebalancePlan;
}

export interface StepReport {
  evaluation: Evaluation;
  results: { move: Move; result: MoveResult }[];
  state: RouterState;
}

const TRADE_KINDS = new Set<Move['kind']>(['momentum-exit', 'hedge-sell', 'stake-withdraw', 'hedge-buy', 'stake-deposit']);

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

    const trend = signals ? classifyTrend(signals, policy, trendOf(state.tracker.active)) : null;
    const observed = classifyRegime(trend, heat);
    const update = dataIssue ? null : updateRegime(state.tracker, observed, now, policy);
    const regime = update ? update.state.active : state.tracker.active;
    const tw = targetWeights(regime, policy, signals);
    notes.push(...tw.notes);
    if (!signals) notes.push(`need ${minimumBars(policy)} hourly bars of history, have ${bars.length}: staying in the "unknown" allocation`);
    const snapshot = await takeSnapshot(sleeves, this.d.momentumState());
    const plan = planRebalance(snapshot.holdings, tw.weights, policy);
    notes.push(...plan.notes);
    return { at: now, signals, heat, trend, observed, dataIssue, update, regime, weights: tw.weights, notes, snapshot, plan };
  }

  /**
   * One decision cycle. With a signer, executes the moves one at a time, re-reading the
   * wallet between moves; without one, simulates only the first move (later moves depend
   * on it) and changes nothing on-chain. The regime tracker only advances when `commit`.
   */
  async step(opts: { commit: boolean }): Promise<StepReport> {
    const state = this.state();
    const evaluation = await this.evaluate(state);
    const results: StepReport['results'] = [];
    const live = this.d.sleeves.signer !== null;

    if (opts.commit) {
      if (evaluation.update) {
        if (evaluation.update.switched) {
          state.switches.push({ t: evaluation.at, from: state.tracker.active, to: evaluation.update.state.active });
          if (state.switches.length > 200) state.switches.splice(0, state.switches.length - 200);
        }
        state.tracker = evaluation.update.state;
      }
      state.lastEvaluatedAt = evaluation.at;
      state.lastObserved = evaluation.observed;
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
          result = { ok: true, status: 'confirmed', detail: await this.d.momentumExit() };
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
        plan = planRebalance(snapshot.holdings, evaluation.weights, this.d.policy);
      }
    }
    if (opts.commit) this.d.store.save(state);
    return { evaluation, results, state };
  }
}
