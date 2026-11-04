// Strategy router: indicators, price parsing, regime detection, switching discipline,
// allocation, rebalance planning and the backtester.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ema, realizedVolAnnualPct, sma } from '../src/router/indicators.ts';
import { cleanBars, parsePriceCsv, parsePythHistory, type PriceBar } from '../src/router/prices.ts';
import { parseRouterPolicy, type RouterPolicy } from '../src/router/policy.ts';
import { classifyRegime, classifyTrend, computeSignals, initialTracker, memeHeat, minimumBars, updateRegime, type Signals } from '../src/router/regime.ts';
import { planRebalance, targetWeights, type Holdings } from '../src/router/allocator.ts';
import { runBacktest } from '../src/router/backtest.ts';
import { parseBotPolicy } from '../src/bot/policy.ts';
import { parseToken } from '../src/bot/feed.ts';
import { TOKEN_PROGRAM_ID } from '../src/solana/constants.ts';
import { MockJupiter } from './mock-jupiter.ts';
import { MockChain } from './mock-chain.ts';
import { REPO_ROOT } from './world.ts';
import { series } from './price-fixtures.ts';

const routerJson = () => JSON.parse(readFileSync(resolve(REPO_ROOT, 'config/router-policy.json'), 'utf8')) as Record<string, unknown>;
const policyWith = (o: Record<string, unknown> = {}): RouterPolicy => parseRouterPolicy({ ...routerJson(), ...o });
const H = 3_600_000;
const T0 = Date.parse('2026-01-01T00:00:00Z');

const signalsOf = (bars: PriceBar[], p: RouterPolicy): Signals => computeSignals(bars.map((b) => b.close), bars.map((b) => b.t), p)!;

test('EMA, SMA and realized volatility', () => {
  assert.deepEqual(sma([1, 2, 3, 4, 5], 3).map((x) => (Number.isNaN(x) ? null : x)), [null, null, 2, 3, 4]);
  const e = ema([1, 2, 3, 4, 5, 6], 3);
  assert.ok(Number.isNaN(e[1]!));
  assert.equal(e[2], 2); // seeded with SMA(1,2,3)
  assert.equal(e[3], 0.5 * 4 + 0.5 * 2); // alpha = 2/(3+1)
  assert.equal(e[4], 0.5 * 5 + 0.5 * 3);
  assert.equal(realizedVolAnnualPct(new Array(200).fill(100), 168), 0);
  // Alternating +1%/-1% log moves: hourly stdev ~= 0.01 -> ~93.6%/yr.
  const alt = [100];
  for (let i = 1; i < 200; i++) alt.push(alt[i - 1]! * Math.exp(i % 2 ? 0.01 : -0.01));
  const v = realizedVolAnnualPct(alt, 168);
  assert.ok(v > 90 && v < 97, `vol ${v}`);
});

test('price history parsing: Pyth TradingView shim, CSV, cleaning', () => {
  assert.deepEqual(parsePythHistory({ s: 'ok', t: [1_700_000_000, 1_700_003_600], c: [100.5, 101] }), [
    { t: 1_700_000_000_000, close: 100.5 },
    { t: 1_700_003_600_000, close: 101 },
  ]);
  assert.deepEqual(parsePythHistory({ s: 'no_data' }), []);
  assert.throws(() => parsePythHistory({ s: 'error', errmsg: 'bad symbol' }), /bad symbol/);
  assert.throws(() => parsePythHistory({ s: 'ok', t: [1], c: [] }), /malformed/);
  const csv = 'timestamp,price\n2026-01-01T00:10:00Z,150\n2026-01-01T00:50:00Z,151\n1767229200,152\n# comment\n1767232800000,153\n';
  const bars = parsePriceCsv(csv);
  assert.deepEqual(bars.map((b) => b.close), [151, 152, 153], 'one bar per hour, last value wins');
  assert.throws(() => parsePriceCsv('2026-01-01T00:00:00Z,abc\n2026-01-01T01:00:00Z,abc'), /bad price/);
  assert.deepEqual(cleanBars([{ t: 2 * H, close: 2 }, { t: H, close: 1 }, { t: 3 * H, close: -1 }, { t: 4 * H, close: Number.NaN }]), [{ t: H, close: 1 }, { t: 2 * H, close: 2 }]);
});

test('trend classification: up, down, range, and not enough data', () => {
  const p = policyWith();
  assert.equal(computeSignals([1, 2, 3], [1, 2, 3], p), null);
  assert.equal(minimumBars(p), 336);
  assert.equal(classifyTrend(signalsOf(series(600, 200, 1.6), p), p), 'up');
  assert.equal(classifyTrend(signalsOf(series(600, 200, 0.6), p), p), 'down');
  assert.equal(classifyTrend(signalsOf(series(600, 600, 1), p), p), 'range');
});

test('hysteresis: an established trend persists until the gap shrinks below the exit threshold', () => {
  const p = policyWith();
  const s = { ...signalsOf(series(600, 600, 1), p), trendPct: -2, priceVsSlowPct: -1 };
  assert.equal(classifyTrend(s, p, null), 'range', 'a fresh reading needs the full -3% to call a downtrend');
  assert.equal(classifyTrend(s, p, 'down'), 'down', 'an active downtrend holds while the gap stays below -1%');
  assert.equal(classifyTrend({ ...s, trendPct: -0.5 }, p, 'down'), 'range');
  assert.equal(classifyTrend({ ...s, trendPct: 2, priceVsSlowPct: 1 }, p, 'up'), 'up');
});

test('regimes from trend and memecoin heat', () => {
  const chain = new MockChain();
  const jup = new MockJupiter(chain);
  const botPolicy = parseBotPolicy(JSON.parse(readFileSync(resolve(REPO_ROOT, 'config/bot-policy.json'), 'utf8')));
  const now = Date.now();
  const toks = Array.from({ length: 10 }, (_, i) => jup.addToken({ symbol: `M${i}`, decimals: 6, tokenProgram: TOKEN_PROGRAM_ID, lamportsPerToken: 1000 }));
  const hot = toks.map((t) => parseToken(jup.feedEntry(t, {}, now))!);
  const cold = toks.map((t, i) => parseToken(jup.feedEntry(t, { stats1h: { priceChange: i < 3 ? 20 : -15, buyVolume: 1e5, sellVolume: 2e5 } }, now))!);
  const p = policyWith();
  const h = memeHeat(hot, botPolicy, p, now);
  assert.equal(h.hot, true);
  assert.equal(h.breadth, 1);
  const c = memeHeat(cold, botPolicy, p, now);
  assert.equal(c.hot, false);
  assert.ok(Math.abs(c.breadth - 0.3) < 1e-9);
  assert.equal(classifyRegime('up', h), 'risk-on');
  assert.equal(classifyRegime('up', c), 'uptrend');
  assert.equal(classifyRegime('up', null), 'uptrend');
  assert.equal(classifyRegime('range', h), 'range');
  assert.equal(classifyRegime('down', h), 'downtrend', 'a hot memecoin market never overrides a SOL downtrend');
  assert.equal(classifyRegime(null, h), 'unknown');
});

test('switching discipline: confirmations, fast de-risking, slow re-risking', () => {
  const p = policyWith();
  let s = initialTracker(T0);
  // Leaving "unknown" needs confirmations but no dwell.
  for (let i = 0; i < 2; i++) {
    const u = updateRegime(s, 'uptrend', T0 + i * H, p);
    assert.equal(u.switched, false);
    s = u.state;
  }
  let u = updateRegime(s, 'uptrend', T0 + 2 * H, p);
  assert.equal(u.switched, true);
  s = u.state;
  // An interrupted streak starts over.
  s = updateRegime(s, 'downtrend', T0 + 3 * H, p).state;
  s = updateRegime(s, 'range', T0 + 4 * H, p).state;
  assert.equal(s.pending, 'range');
  assert.equal(s.pendingCount, 1);
  // De-risking: downtrend confirmed 3x switches right away (no dwell).
  for (let i = 5; i < 8; i++) u = updateRegime(u.switched ? u.state : s, 'downtrend', T0 + i * H, p), (s = u.state);
  assert.equal(s.active, 'downtrend');
  // Re-risking within 24h is held back even when confirmed…
  for (let i = 8; i < 12; i++) s = updateRegime(s, 'uptrend', T0 + i * H, p).state;
  assert.equal(s.active, 'downtrend');
  assert.match(updateRegime(s, 'uptrend', T0 + 12 * H, p).reason, /min dwell/);
  // …and allowed once the dwell has passed.
  const late = updateRegime(s, 'uptrend', T0 + 40 * H, p);
  assert.equal(late.switched, true);
  assert.equal(late.state.active, 'uptrend');
});

test('target weights by profile, with the volatility overlay', () => {
  const p = policyWith();
  assert.deepEqual(targetWeights('downtrend', p, null).weights, { stake: 0.3, hedge: 0.7, momentum: 0 });
  assert.deepEqual(targetWeights('risk-on', p, null).weights, { stake: 0.8, hedge: 0, momentum: 0.2 });
  const calm = { volAnnualPct: 60 } as Signals;
  const wild = { volAnnualPct: 150 } as Signals;
  assert.deepEqual(targetWeights('risk-on', p, calm).weights, { stake: 0.8, hedge: 0, momentum: 0.2 });
  const w = targetWeights('risk-on', p, wild);
  assert.ok(Math.abs(w.weights.momentum - 0.1) < 1e-9 && Math.abs(w.weights.stake - 0.9) < 1e-9);
  assert.match(w.notes[0]!, /volatility/);
  const agg = policyWith({ profile: 'aggressive' });
  assert.deepEqual(targetWeights('downtrend', agg, null).weights, { stake: 0, hedge: 1, momentum: 0 });
});

const SOL = 1_000_000_000n;
const holdings = (o: Partial<Holdings>): Holdings => ({ solLamports: 0n, stakeLamports: 0n, hedgeLamports: 0n, hedgeUnits: 0n, momentumLamports: 0n, ...o });

test('rebalance planning: fund from liquid, rotate into the hedge, stay put inside the band', () => {
  const p = policyWith();
  // All liquid, everything should be staked (minus the 0.03 reserve).
  let plan = planRebalance(holdings({ solLamports: SOL }), { stake: 1, hedge: 0, momentum: 0 }, p);
  assert.deepEqual(plan.moves, [{ kind: 'stake-deposit', lamports: 970_000_000n }, { kind: 'momentum-budget', lamports: 0n, allowEntries: false }]);
  // Fully staked -> downtrend: unstake first, then buy the hedge with what was freed.
  plan = planRebalance(holdings({ solLamports: 30_000_000n, stakeLamports: 970_000_000n }), { stake: 0.3, hedge: 0.7, momentum: 0 }, p);
  assert.equal(plan.moves[0]!.kind, 'stake-withdraw');
  assert.equal((plan.moves[0] as { lamports: bigint }).lamports, 970_000_000n - 291_000_000n);
  assert.deepEqual(plan.moves[1], { kind: 'hedge-buy', lamports: 679_000_000n });
  // Slightly off target: inside the 10% band, no trades.
  plan = planRebalance(holdings({ solLamports: 30_000_000n, stakeLamports: 900_000_000n, hedgeLamports: 70_000_000n, hedgeUnits: 10n }), { stake: 1, hedge: 0, momentum: 0 }, p);
  assert.equal(plan.moves.filter((m) => m.kind !== 'momentum-budget').length, 1, 'only the hedge is sold: its target is zero');
  assert.equal(plan.moves[0]!.kind, 'hedge-sell');
  plan = planRebalance(holdings({ solLamports: 80_000_000n, stakeLamports: 920_000_000n }), { stake: 1, hedge: 0, momentum: 0 }, p);
  assert.equal(plan.moves.filter((m) => m.kind !== 'momentum-budget').length, 0, '5% off target is inside the band');
});

test('rebalance planning: back from the hedge, memecoin earmark, exits when switched off', () => {
  const p = policyWith();
  // Uptrend after a downtrend: sell all USDC, then stake it.
  let plan = planRebalance(holdings({ solLamports: 30_000_000n, stakeLamports: 300_000_000n, hedgeLamports: 700_000_000n, hedgeUnits: 105_000_000n }), { stake: 1, hedge: 0, momentum: 0 }, p);
  assert.deepEqual(plan.moves[0], { kind: 'hedge-sell', units: 105_000_000n, lamports: 700_000_000n });
  assert.deepEqual(plan.moves[1], { kind: 'stake-deposit', lamports: 700_000_000n });
  // Risk-on: 20% earmarked for memecoins stays liquid instead of being staked.
  plan = planRebalance(holdings({ solLamports: SOL }), { stake: 0.8, hedge: 0, momentum: 0.2 }, p);
  assert.deepEqual(plan.moves, [{ kind: 'stake-deposit', lamports: 776_000_000n }, { kind: 'momentum-budget', lamports: 194_000_000n, allowEntries: true }]);
  // Memecoins switched off: by default positions finish on their own exit rules…
  plan = planRebalance(holdings({ solLamports: 30_000_000n, stakeLamports: 800_000_000n, momentumLamports: 170_000_000n }), { stake: 1, hedge: 0, momentum: 0 }, p);
  assert.ok(!plan.moves.some((m) => m.kind === 'momentum-exit'));
  // …or are closed immediately when the policy says so.
  plan = planRebalance(holdings({ solLamports: 30_000_000n, stakeLamports: 800_000_000n, momentumLamports: 170_000_000n }), { stake: 1, hedge: 0, momentum: 0 }, { ...p, momentumExitOnDisable: true });
  assert.equal(plan.moves[0]!.kind, 'momentum-exit');
  // Never spends the fee reserve.
  plan = planRebalance(holdings({ solLamports: 40_000_000n }), { stake: 1, hedge: 0, momentum: 0 }, p);
  assert.equal(plan.moves.filter((m) => m.kind !== 'momentum-budget').length, 0, '0.01 SOL above the reserve is below the minimum trade');
});

test('backtest: rotating into the hedge in a crash beats staking in SOL; a rally costs almost nothing', () => {
  const p = policyWith();
  const crash = runBacktest(series(24 * 90, 24 * 30, 0.5), p, { startLamports: SOL });
  assert.ok(crash.finalSol > crash.stakedOnlySol * 1.2, `crash: ${crash.finalSol} vs ${crash.stakedOnlySol}`);
  assert.ok(crash.maxDrawdownUsdPct < crash.stakedOnlyMaxDrawdownUsdPct, 'hedging cuts the USD drawdown');
  assert.ok(crash.hoursInRegime.downtrend > 0 && crash.switches.length <= 4, `switches ${crash.switches.length}`);
  const rally = runBacktest(series(24 * 90, 24 * 30, 2), p, { startLamports: SOL });
  assert.ok(Math.abs(rally.finalSol / rally.stakedOnlySol - 1) < 0.005, `rally: ${rally.finalSol} vs ${rally.stakedOnlySol}`);
  for (const r of [crash, rally]) {
    assert.equal(Object.values(r.hoursInRegime).reduce((a, b) => a + b, 0), r.bars);
    assert.ok(r.feesSol >= 0 && r.finalSol > 0);
    assert.equal(r.hoursInRegime['risk-on'], 0, 'memecoin regime cannot occur without memecoin data');
  }
  // A conservative profile hedges less: less gain in a crash.
  const cons = runBacktest(series(24 * 90, 24 * 30, 0.5), policyWith({ profile: 'conservative' }), { startLamports: SOL });
  assert.ok(cons.finalSol < crash.finalSol && cons.finalSol > cons.stakedOnlySol);
});

test('router policy validation', () => {
  assert.throws(() => policyWith({ profile: 'yolo' }), /not one of/);
  assert.throws(() => policyWith({ extra: 1 }), /unknown key/);
  assert.throws(() => policyWith({ feeReserveSol: '0.001' }), /at least 0.02/);
  assert.throws(() => policyWith({ trend: { fastHours: 24, slowHours: 168, bullThresholdPct: 3, bearThresholdPct: 3, exitThresholdPct: 5 } }), /exitThresholdPct/);
  assert.throws(() => policyWith({ trend: { fastHours: 200, slowHours: 168, bullThresholdPct: 3, bearThresholdPct: 3, exitThresholdPct: 1 } }), /shorter/);
  const json = routerJson();
  const profiles = JSON.parse(JSON.stringify(json.profiles)) as Record<string, Record<string, unknown>>;
  profiles.balanced!['risk-on'] = { stake: 0.9, hedge: 0, momentum: 0.2 };
  assert.throws(() => parseRouterPolicy({ ...json, profiles }), /more than 1/);
});
