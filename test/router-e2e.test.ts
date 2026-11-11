// The strategy router end to end on the mock chain: real (mock) stake-pool deposits and
// withdrawals and USDC swaps through the firewalls, driven by synthetic market regimes.
// Also the `solprofits auto` CLI as a child process.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AppConfig } from '../src/config.ts';
import { signerFromSecretKey } from '../src/crypto/keys.ts';
import { parseBotPolicy } from '../src/bot/policy.ts';
import { USDC_MINT } from '../src/bot/cli.ts';
import { parseRouterPolicy } from '../src/router/policy.ts';
import { Router, RouterStore, type PriceSource } from '../src/router/router.ts';
import { takeSnapshot, type SleeveDeps } from '../src/router/sleeves.ts';
import type { PriceBar } from '../src/router/prices.ts';
import { TOKEN_PROGRAM_ID } from '../src/solana/constants.ts';
import { deriveAssociatedTokenAddress } from '../src/solana/programs.ts';
import { encodeBase58 } from '../src/util/base58.ts';
import { poolConfigOf } from './fixtures.ts';
import { serveMockChain } from './mock-chain.ts';
import { MockJupiter, serveMockJupiter } from './mock-jupiter.ts';
import { seriesEndingAt, series, toCsv } from './price-fixtures.ts';
import { REPO_ROOT, scenario } from './world.ts';

const H = 3_600_000;
const readJson = (p: string) => JSON.parse(readFileSync(resolve(REPO_ROOT, p), 'utf8'));

function routerWorld(live = true) {
  const s = scenario();
  const jup = new MockJupiter(s.chain);
  jup.addToken({ mint: USDC_MINT, symbol: 'USDC', decimals: 6, tokenProgram: TOKEN_PROGRAM_ID, lamportsPerToken: 1e9 / 150 });
  const dir = mkdtempSync(join(tmpdir(), 'solprofits-router-'));
  const cfg: AppConfig = {
    repoRoot: REPO_ROOT,
    rpcUrl: 'http://localhost:1',
    walletAddress: s.wallet,
    policy: s.policy,
    pools: s.pools,
    ledgerPath: join(dir, 'ledger.jsonl'),
    haltFile: join(dir, 'HALT'),
    isHalted: () => false,
  };
  const policy = parseRouterPolicy(readJson('config/router-policy.json'));
  const botPolicy = parseBotPolicy(readJson('config/bot-policy.json'));
  const clock = { now: Date.parse('2026-06-01T12:00:00Z') };
  let bars: PriceBar[] = [];
  /** Market shape ending at the current clock with SOL at `price`; the mock DEX quotes the same price. */
  const market = (price: number, endMultiple: number) => {
    bars = seriesEndingAt(clock.now, price, 900, 500, endMultiple);
    jup.setPrice(USDC_MINT, 1e9 / price);
  };
  const prices: PriceSource = { history: async (now) => bars.filter((b) => b.t <= now) };
  const sleeves: SleeveDeps = {
    cfg,
    rpc: s.rpc,
    jupiter: jup,
    wallet: s.wallet,
    signer: live ? signerFromSecretKey(s.walletKp.secretKey) : null,
    router: policy,
    maxPriorityFeeLamports: botPolicy.maxPriorityFeeLamports,
    rentTokenAccount: 2_039_280n,
    isHalted: () => false,
    log: () => {},
    sleep: async () => {},
  };
  const store = new RouterStore(join(dir, 'router-state.json'));
  const router = new Router({ sleeves, policy, botPolicy, prices, feed: null, store, momentumState: () => null, now: () => clock.now });
  const usdcAta = deriveAssociatedTokenAddress(s.wallet, USDC_MINT, TOKEN_PROGRAM_ID);
  const holdings = async () => (await takeSnapshot(sleeves, null)).holdings;
  return { s, jup, router, clock, market, store, usdcAta, holdings };
}

test('router: stake in good times, rotate into USDC in a confirmed downtrend, refuse bad data, re-risk slowly', async () => {
  const w = routerWorld();
  // 1) Uptrend at $150. Start-up regime is "unknown" (stake everything) until the trend is confirmed.
  w.market(150, 1.3);
  let r = await w.router.step({ commit: true });
  assert.equal(r.evaluation.regime, 'unknown');
  assert.equal(r.evaluation.observed, 'uptrend');
  assert.deepEqual(r.results.map((x) => [x.move.kind, x.result.status]), [['stake-deposit', 'confirmed']]);
  let h = await w.holdings();
  assert.ok(h.stakeLamports > 960_000_000n, `staked ${h.stakeLamports}`);
  for (let i = 0; i < 2; i++) {
    w.clock.now += H;
    r = await w.router.step({ commit: true });
  }
  assert.equal(r.evaluation.regime, 'uptrend');
  assert.equal(r.results.length, 0, 'same allocation: nothing to trade');

  // 2) SOL falls to $100. Three hourly confirmations, then de-risk immediately (no dwell).
  for (let i = 0; i < 3; i++) {
    w.clock.now += H;
    w.market(100, 0.6);
    r = await w.router.step({ commit: true });
  }
  assert.equal(r.evaluation.regime, 'downtrend');
  assert.deepEqual(r.results.map((x) => [x.move.kind, x.result.status]), [['stake-withdraw', 'confirmed'], ['hedge-buy', 'confirmed']]);
  h = await w.holdings();
  const usdc = w.s.chain.tokenBalance(w.usdcAta)!;
  assert.ok(usdc > 65_000_000n, `bought ${usdc} USDC units`); // ~0.68 SOL at $100 ≈ 67.8 USDC
  const total = h.solLamports + h.stakeLamports + h.hedgeLamports;
  assert.ok(Number(h.hedgeLamports) / Number(total) > 0.6, 'about 70% hedged');
  assert.equal(w.router.state().switches.at(-1)?.to, 'downtrend');

  // 3) Bad data: history says $100, the live quote says $200 -> no regime change, no trades.
  w.clock.now += H;
  w.market(100, 0.6);
  w.jup.setPrice(USDC_MINT, 1e9 / 200);
  r = await w.router.step({ commit: true });
  assert.match(r.evaluation.dataIssue ?? '', /disagree/);
  assert.equal(r.results.length, 0);
  // Stale data is refused too.
  w.clock.now += 5 * H;
  r = await w.router.step({ commit: true });
  assert.match(r.evaluation.dataIssue ?? '', /stale/);

  // 4) Recovery from a lower base: uptrend to $90. Confirmed, but taking risk back waits out the 24h dwell.
  for (let i = 0; i < 4; i++) {
    w.clock.now += H;
    w.market(90, 1.5);
    r = await w.router.step({ commit: true });
  }
  assert.equal(r.evaluation.regime, 'downtrend');
  assert.match(r.evaluation.update?.reason ?? '', /min dwell/);
  // After a 20h gap the confirmations start over: three fresh hourly readings are needed.
  w.clock.now += 20 * H;
  w.market(90, 1.5);
  r = await w.router.step({ commit: true });
  assert.equal(r.evaluation.regime, 'downtrend');
  assert.match(r.evaluation.notes.join(' '), /starts its confirmations over/);
  for (let i = 0; i < 2; i++) {
    w.clock.now += H;
    w.market(90, 1.5);
    r = await w.router.step({ commit: true });
  }
  assert.equal(r.evaluation.regime, 'uptrend');
  assert.deepEqual(r.results.map((x) => [x.move.kind, x.result.status]), [['hedge-sell', 'confirmed'], ['stake-deposit', 'confirmed']]);
  assert.equal(w.s.chain.tokenBalance(w.usdcAta), 0n);
  const after = await w.holdings();
  const finalSol = after.solLamports + after.stakeLamports + after.hedgeLamports;
  // Sold SOL at ~$100, bought back at ~$90: more SOL than the ~0.999 the wallet had after the first deposit.
  assert.ok(finalSol > 1_050_000_000n, `ended with ${finalSol} lamports`);
});

test('router dry run simulates the first move and changes nothing', async () => {
  const w = routerWorld(false);
  w.market(150, 1.3);
  const r = await w.router.step({ commit: false });
  assert.deepEqual(r.results.map((x) => [x.move.kind, x.result.status]), [['stake-deposit', 'simulated']]);
  assert.equal(w.s.chain.sentSignatures.length, 0);
  assert.equal(w.router.state().lastEvaluatedAt, 0, 'tracker not advanced');
});

// ------------------------------------------------------------------ CLI

function run(args: string[], env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [resolve(REPO_ROOT, 'src/cli.ts'), 'auto', ...args], { cwd: REPO_ROOT, env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
}

test('auto CLI: backtest offline, regime/plan dry runs, refusals, live run, status', async (t) => {
  const s = scenario();
  const jup = new MockJupiter(s.chain);
  jup.addToken({ mint: USDC_MINT, symbol: 'USDC', decimals: 6, tokenProgram: TOKEN_PROGRAM_ID, lamportsPerToken: 1e9 / 150 });
  const rpc = await serveMockChain(s.chain);
  const api = await serveMockJupiter(jup);
  const dir = mkdtempSync(join(tmpdir(), 'solprofits-auto-cli-'));
  const poolsPath = join(dir, 'pools.json');
  writeFileSync(poolsPath, JSON.stringify([poolConfigOf(s.jito, 'JitoSOL'), poolConfigOf(s.blaze, 'bSOL')]));
  const liveCsv = join(dir, 'live.csv');
  writeFileSync(liveCsv, toCsv(seriesEndingAt(Date.now(), 150, 900, 500, 1.3)));
  const crashCsv = join(dir, 'crash.csv');
  writeFileSync(crashCsv, toCsv(series(24 * 90, 24 * 30, 0.5)));
  const env = { SOLANA_RPC_URL: rpc.url, JUPITER_API_URL: api.url, SOLPROFITS_POOLS: poolsPath, SOLPROFITS_DATA_DIR: join(dir, 'data'), SOLPROFITS_LEDGER: join(dir, 'ledger.jsonl') };
  try {
    await t.test('backtest from a CSV, no network needed', async () => {
      const r = await run(['backtest', '--csv', crashCsv], { PATH: process.env.PATH ?? '' });
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /Backtest .* profile "balanced"/);
      assert.match(r.stdout, /regime switching .*\n {2}staked only/);
      assert.match(r.stdout, /Switching beat staking by/);
      const agg = await run(['backtest', '--csv', crashCsv, '--profile', 'aggressive', '--json'], { PATH: process.env.PATH ?? '' });
      const j = JSON.parse(agg.stdout) as { finalSol: number; stakedOnlySol: number };
      assert.ok(j.finalSol > j.stakedOnlySol);
    });
    await t.test('regime and plan are read-only dry runs', async () => {
      const r = await run(['regime', '--csv', liveCsv, '--address', s.wallet], env);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /Market: SOL \$150\.00/);
      assert.match(r.stdout, /Observed now: uptrend · active regime: unknown/);
      const p = await run(['plan', '--csv', liveCsv, '--address', s.wallet], env);
      assert.equal(p.code, 0, p.stderr);
      assert.match(p.stdout, /stake 0\.97 SOL/);
      assert.match(p.stdout, /✓ simulated: stake 0\.97 SOL/);
      assert.match(p.stdout, /Dry run only/);
      assert.equal(s.chain.sentSignatures.length, 0);
    });
    await t.test('live run needs --execute', async () => {
      const r = await run(['run', '--once', '--csv', liveCsv], { ...env, SOLANA_KEYPAIR: encodeBase58(s.walletKp.secretKey) });
      assert.equal(r.code, 3);
      assert.match(r.stderr, /needs --execute/);
    });
    await t.test('live run executes the allocation and records the regime state', async () => {
      const r = await run(['run', '--execute', '--yes', '--once', '--csv', liveCsv], { ...env, SOLANA_KEYPAIR: encodeBase58(s.walletKp.secretKey) });
      assert.equal(r.code, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /Pre-flight/);
      assert.match(r.stdout, /✓ confirmed: stake 0\.97 SOL/);
      const st = await run(['status', '--address', s.wallet], env);
      assert.match(st.stdout, /Active regime: unknown .* pending uptrend \(1\/3\)/);
    });
  } finally {
    rpc.server.close();
    api.server.close();
  }
});

test('circuit breaker: a hedge caught by a rally trips it, the wallet returns to staking, and only resume re-arms it', async () => {
  const w = routerWorld();
  // Confirmed downtrend at $100: 70% goes into USDC. The first step also sets the baseline.
  for (let i = 0; i < 3; i++) {
    w.market(100, 0.6);
    await w.router.step({ commit: true });
    w.clock.now += H;
  }
  assert.equal(w.router.state().tracker.active, 'downtrend');
  assert.ok((w.s.chain.tokenBalance(w.usdcAta) ?? 0n) > 60_000_000n);
  const base = w.router.state().baseline!;
  assert.equal(base.pool, 'JitoSOL');
  assert.ok(BigInt(base.totalLamports) > 999_000_000n);

  // SOL jumps to $125 while the history still reads as a downtrend: the USDC buys back far less SOL.
  w.market(125, 0.6);
  let r = await w.router.step({ commit: true });
  assert.equal(r.evaluation.breakerTripped, true, JSON.stringify(r.evaluation.performance, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  assert.ok(r.evaluation.performance!.relativePct < -10);
  assert.deepEqual(r.evaluation.weights, { stake: 1, hedge: 0, momentum: 0 });
  assert.deepEqual(r.results.map((x) => [x.move.kind, x.result.status]), [['hedge-sell', 'confirmed'], ['stake-deposit', 'confirmed']]);
  assert.equal(w.s.chain.tokenBalance(w.usdcAta), 0n);
  assert.ok(w.router.state().breaker);

  // Still a downtrend an hour later: the breaker keeps it in staking only.
  w.clock.now += H;
  w.market(125, 0.6);
  r = await w.router.step({ commit: true });
  assert.equal(r.evaluation.regime, 'downtrend');
  assert.equal(r.evaluation.breakerActive, true);
  assert.equal(r.results.length, 0);

  // Resume clears it and restarts tracking from the current value.
  const { resumeState } = await import('../src/router/router.ts');
  w.store.save(resumeState(w.router.state()));
  w.clock.now += H;
  w.market(125, 0.6);
  r = await w.router.step({ commit: true });
  assert.equal(r.evaluation.breakerActive, false);
  assert.equal(r.results[0]?.move.kind, 'stake-withdraw', 're-armed: the downtrend allocation applies again');
  assert.ok(BigInt(w.router.state().baseline!.totalLamports) < BigInt(base.totalLamports));
});

test('monitor counts the hedge instead of raising a false "drained" alarm; unvalued holdings downgrade it', async () => {
  const { runMonitor } = await import('../src/core/monitor.ts');
  const { otherHoldings } = await import('../src/router/valuation.ts');
  const { load } = await import('./world.ts');
  const { encodeTokenAccount } = await import('./fixtures.ts');
  const w = routerWorld();
  // 0.3 SOL liquid + 105 USDC (worth 0.7 SOL at $150).
  w.s.chain.setWallet(w.s.wallet, 300_000_000n);
  w.s.chain.setAccount(w.usdcAta, { lamports: 2_039_280n, owner: TOKEN_PROGRAM_ID, data: encodeTokenAccount({ mint: USDC_MINT, owner: w.s.wallet, amount: 105_000_000n }) });
  const world = await load(w.s);
  const base = { chain: world.ctx, policy: w.s.policy, evaluations: world.evaluations, programs: [], portfolio: world.portfolio };
  assert.ok(runMonitor(base).alerts.some((a) => a.code === 'value-floor'), 'without the hedge the wallet looks drained');
  const env = { SOLPROFITS_DATA_DIR: mkdtempSync(join(tmpdir(), 'solprofits-val-')) };
  const valued = await otherHoldings({ rpc: w.s.rpc, wallet: w.s.wallet, repoRoot: REPO_ROOT, env, quoter: w.jup });
  assert.equal(valued.length, 1);
  assert.ok(valued[0]!.valueLamports! > 690_000_000n);
  assert.ok(!runMonitor({ ...base, otherHoldings: valued }).alerts.some((a) => a.code === 'value-floor' || a.code === 'value-unknown'));
  const failing = await otherHoldings({ rpc: w.s.rpc, wallet: w.s.wallet, repoRoot: REPO_ROOT, env, quoter: { quote: async () => { throw new Error('offline'); } } });
  assert.equal(failing[0]!.valueLamports, null);
  const report = runMonitor({ ...base, otherHoldings: failing });
  assert.ok(report.alerts.some((a) => a.code === 'value-unknown' && a.level === 'warning'));
  assert.ok(!report.alerts.some((a) => a.code === 'value-floor'));
});

test('trading lock: a second loop is refused while the first is alive; a stale lock is taken over', async () => {
  const { acquireLock } = await import('../src/util/lock.ts');
  const path = join(mkdtempSync(join(tmpdir(), 'solprofits-lock-')), 'trader.lock');
  writeFileSync(path, `${process.ppid} other\n`); // a live process that is not us
  assert.throws(() => acquireLock(path, 'test'), /already running/);
  writeFileSync(path, '999999999 dead\n');
  const release = acquireLock(path, 'test');
  assert.match(readFileSync(path, 'utf8'), new RegExp(`^${process.pid} test`));
  release();
  assert.throws(() => readFileSync(path, 'utf8'));
});
