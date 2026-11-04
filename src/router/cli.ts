// `solprofits auto <command>` — switches between strategies based on market conditions.

import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../config.ts';
import { loadSignerFromEnv, toAddress, type Address, type Signer } from '../crypto/keys.ts';
import { GENESIS_HASHES, TOKEN_ACCOUNT_SIZE, TOKEN_PROGRAM_ID } from '../solana/constants.ts';
import { Rpc } from '../solana/rpc.ts';
import { formatSol, parseSol } from '../util/amount.ts';
import { acquireLock } from '../util/lock.ts';
import { Engine, EventLog, LiveBroker } from '../bot/engine.ts';
import { JupiterTokenFeed } from '../bot/feed.ts';
import { DEFAULT_JUPITER_URL, JupiterClient, WSOL_MINT } from '../bot/jupiter.ts';
import { parseBotPolicy } from '../bot/policy.ts';
import { StateStore } from '../bot/state.ts';
import { executeSwap } from '../bot/swap.ts';
import { describeMove } from './allocator.ts';
import { runBacktest } from './backtest.ts';
import { parseRouterPolicy, REGIMES, type RouterPolicy } from './policy.ts';
import { cleanBars, parsePriceCsv, PythBenchmarks, DEFAULT_PYTH_URL, type PriceBar } from './prices.ts';
import { minimumBars } from './regime.ts';
import { Router, RouterStore, type Evaluation, type PriceSource, type StepReport } from './router.ts';
import type { SleeveDeps } from './sleeves.ts';

export const AUTO_HELP = `solprofits auto — switch between strategies based on market conditions (docs/STRATEGIES.md)

  auto regime [--csv FILE]                Read market conditions and show which strategy mix they call for
  auto plan [--address A] [--csv FILE]    Dry run: the moves the router would make for this wallet now (simulated)
  auto run --execute [--yes] [--once]     LIVE: rebalance between staking, the USDC hedge and the memecoin bot
  auto status                             Active regime, pending switch, switch history, memecoin budget
  auto backtest [--csv FILE | --days N] [--profile P] [--start-sol 1] [--json]
                                          Replay the switching rules on SOL price history vs staking only

Environment: as for the other commands, plus PYTH_BENCHMARKS_URL (default ${DEFAULT_PYTH_URL}).
Profiles (config/router-policy.json): conservative, balanced (default), aggressive.`;

const out = (l = '') => process.stdout.write(l + '\n');
const err = (l: string) => process.stderr.write(l + '\n');
const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const s4 = (l: bigint) => formatSol(l, 4);

class CsvPriceSource implements PriceSource {
  private readonly bars: PriceBar[];
  constructor(bars: PriceBar[]) {
    this.bars = bars;
  }
  async history(nowMs: number): Promise<PriceBar[]> {
    return this.bars.filter((b) => b.t <= nowMs);
  }
}

class PythPriceSource implements PriceSource {
  private readonly pyth: PythBenchmarks;
  constructor(pyth: PythBenchmarks) {
    this.pyth = pyth;
  }
  history(nowMs: number, hours: number): Promise<PriceBar[]> {
    return this.pyth.hourly(nowMs - hours * 3_600_000, nowMs);
  }
}

function printEvaluation(ev: Evaluation, policy: RouterPolicy, activeBefore: string): void {
  const s = ev.signals;
  if (s) {
    out(
      `Market: SOL $${s.close.toFixed(2)} · 1d vs 7d average ${s.trendPct >= 0 ? '+' : ''}${s.trendPct.toFixed(1)}% · price vs 7d ${s.priceVsSlowPct >= 0 ? '+' : ''}${s.priceVsSlowPct.toFixed(1)}% · volatility ${s.volAnnualPct.toFixed(0)}%/yr`,
    );
  } else {
    out(`Market: not enough price history yet (${minimumBars(policy)} hourly bars needed)`);
  }
  if (ev.heat) out(`Memecoins: ${pct(ev.heat.breadth)} of the top ${ev.heat.sampled} trending are rising, ${ev.heat.passing} pass the bot's filters → ${ev.heat.hot ? 'HOT' : 'not hot'}`);
  if (ev.dataIssue) out(`DATA PROBLEM: ${ev.dataIssue} — no regime change and no trades this cycle`);
  out(`Observed now: ${ev.observed} · active regime: ${ev.regime}${ev.update ? ` (${ev.update.reason})` : ` (was ${activeBefore})`}`);
  const w = ev.weights;
  out(`Profile "${policy.profile}" → stake ${pct(w.stake)}, ${policy.hedge.symbol} hedge ${pct(w.hedge)}, memecoins ${pct(w.momentum)}, liquid SOL ${pct(Math.max(0, 1 - w.stake - w.hedge - w.momentum))}`);
  for (const n of ev.notes) out(`  note: ${n}`);
}

function printPlan(r: StepReport, policy: RouterPolicy): void {
  const h = r.evaluation.snapshot.holdings;
  const p = r.evaluation.plan;
  out(`Holdings: SOL ${s4(h.solLamports)} · staked ${s4(h.stakeLamports)} · ${policy.hedge.symbol} worth ${s4(h.hedgeLamports)} SOL · memecoins ${s4(h.momentumLamports)} · total ${s4(p.totalLamports)} SOL`);
  out(`Targets:  staked ${s4(p.targets.stake)} · ${policy.hedge.symbol} ${s4(p.targets.hedge)} · memecoins ≤ ${s4(p.targets.momentum)} (rebalance band ±${policy.rebalance.bandPct}%)`);
  const trades = p.moves.filter((m) => m.kind !== 'momentum-budget');
  if (trades.length === 0) out('Moves: none (everything is within its band)');
  for (const m of p.moves) out(`  · ${describeMove(m, s4, policy.hedge.symbol)}`);
  for (const { move, result } of r.results) out(`  ${result.ok ? '✓' : '✗'} ${result.status}: ${describeMove(move, s4, policy.hedge.symbol)} — ${result.detail}`);
}

export async function autoMain(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      address: { type: 'string' },
      csv: { type: 'string' },
      days: { type: 'string' },
      profile: { type: 'string' },
      'start-sol': { type: 'string' },
      execute: { type: 'boolean' },
      yes: { type: 'boolean' },
      once: { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const cmd = positionals[0] ?? 'help';
  if (cmd === 'help' || values.help) {
    out(AUTO_HELP);
    return 0;
  }
  const cfg = loadConfig(env);
  const policy = parseRouterPolicy(JSON.parse(readFileSync(env.SOLPROFITS_ROUTER_POLICY ?? resolve(cfg.repoRoot, 'config/router-policy.json'), 'utf8')));
  if (values.profile) {
    if (!policy.profiles[values.profile]) throw new Error(`unknown profile "${values.profile}"`);
    policy.profile = values.profile;
  }
  const botPolicy = parseBotPolicy(JSON.parse(readFileSync(env.SOLPROFITS_BOT_POLICY ?? resolve(cfg.repoRoot, 'config/bot-policy.json'), 'utf8')));
  const dataDir = env.SOLPROFITS_DATA_DIR ?? resolve(cfg.repoRoot, 'data');
  const pyth = new PythBenchmarks(env.PYTH_BENCHMARKS_URL?.trim() || DEFAULT_PYTH_URL);
  const csvBars = values.csv ? parsePriceCsv(readFileSync(values.csv, 'utf8')) : null;
  const prices: PriceSource = csvBars ? new CsvPriceSource(csvBars) : new PythPriceSource(pyth);

  if (cmd === 'backtest') {
    let bars: PriceBar[];
    if (csvBars) bars = csvBars;
    else {
      const days = Number(values.days ?? '365');
      if (!Number.isFinite(days) || days < 15 || days > 3_650) throw new Error('--days must be between 15 and 3650');
      const now = Date.now();
      bars = cleanBars(await pyth.hourly(now - days * 86_400_000, now));
    }
    const r = runBacktest(bars, policy, { startLamports: parseSol(values['start-sol'] ?? '1') });
    if (values.json) {
      out(JSON.stringify(r, null, 2));
      return 0;
    }
    const d = (t: number) => new Date(t).toISOString().slice(0, 10);
    out(`Backtest ${d(r.start)} → ${d(r.end)} (${r.bars} hourly bars), profile "${policy.profile}", SOL $${r.startPriceUsd.toFixed(2)} → $${r.endPriceUsd.toFixed(2)}`);
    out(`                     final SOL   final USD    worst drop (SOL)  worst drop (USD)`);
    out(`  regime switching   ${r.finalSol.toFixed(4).padStart(9)}   ${('$' + r.finalUsd.toFixed(2)).padStart(10)}   ${(r.maxDrawdownPct.toFixed(1) + '%').padStart(16)}  ${(r.maxDrawdownUsdPct.toFixed(1) + '%').padStart(16)}`);
    out(`  staked only        ${r.stakedOnlySol.toFixed(4).padStart(9)}   ${('$' + r.stakedOnlyUsd.toFixed(2)).padStart(10)}   ${(r.stakedOnlyMaxDrawdownPct.toFixed(1) + '%').padStart(16)}  ${(r.stakedOnlyMaxDrawdownUsdPct.toFixed(1) + '%').padStart(16)}`);
    const diff = (r.finalSol / r.stakedOnlySol - 1) * 100;
    out(`Switching ${diff >= 0 ? 'beat' : 'trailed'} staking by ${Math.abs(diff).toFixed(2)}% in SOL terms, with ${r.switches.length} regime switches, ${r.moves} trades and ${r.feesSol.toFixed(5)} SOL in fees.`);
    const total = Object.values(r.hoursInRegime).reduce((a, b) => a + b, 0);
    out(`Time in regime: ${REGIMES.filter((g) => r.hoursInRegime[g] > 0).map((g) => `${g} ${((r.hoursInRegime[g] / total) * 100).toFixed(0)}%`).join(', ')}`);
    out('Note: memecoin trading cannot be replayed (no historical memecoin data); its share is treated as staked. Past behaviour does not predict future results.');
    return 0;
  }

  const rpc = new Rpc(cfg.rpcUrl);
  const jupUrl = env.JUPITER_API_URL?.trim() || DEFAULT_JUPITER_URL;
  const jupKey = env.JUPITER_API_KEY?.trim() || undefined;
  const jupiter = new JupiterClient(jupUrl, jupKey);
  const feed = new JupiterTokenFeed(jupUrl, jupKey);
  const routerStorePath = resolve(dataDir, 'router-state.json');
  const botLiveStore = new StateStore(resolve(dataDir, 'bot-live-state.json'));
  const momentumState = () => (botLiveStore.exists() ? botLiveStore.load() : null);

  if (cmd === 'status') {
    const wallet = values.address ? toAddress(values.address) : cfg.walletAddress;
    if (!wallet) throw new Error('pass --address or set WALLET_ADDRESS');
    const st = new RouterStore(routerStorePath).load(wallet, Date.now());
    out(`Active regime: ${st.tracker.active} since ${new Date(st.tracker.activeSince).toISOString()}${st.tracker.pending ? ` · pending ${st.tracker.pending} (${st.tracker.pendingCount}/${policy.switching.confirmations})` : ''}`);
    out(`Last evaluation: ${st.lastEvaluatedAt ? new Date(st.lastEvaluatedAt).toISOString() : 'never'} (observed ${st.lastObserved ?? '-'})`);
    out(`Memecoin budget: ${st.momentum.allowEntries ? `up to ${s4(BigInt(st.momentum.maxExposureLamports))} SOL` : 'no new entries'}`);
    for (const sw of st.switches.slice(-15)) out(`  ${new Date(sw.t).toISOString().slice(0, 16)}  ${sw.from} → ${sw.to}`);
    return 0;
  }

  const rent = await rpc.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_SIZE);
  let signer: Signer | null = null;
  let wallet: Address;
  if (cmd === 'run') {
    if (!values.execute) {
      err('"auto run" trades real SOL and needs --execute. Use "auto plan" for a dry run and "auto backtest" to evaluate the rules.');
      return 3;
    }
    if (cfg.isHalted()) throw new Error('kill switch is active (HALT file or SOLPROFITS_HALT=1)');
    const loaded = loadSignerFromEnv(env);
    signer = loaded.signer;
    for (const w of loaded.warnings) err(`warning: ${w}`);
    if (cfg.walletAddress && cfg.walletAddress !== signer.address) throw new Error(`signing key ${signer.address} does not match WALLET_ADDRESS ${cfg.walletAddress}`);
    wallet = signer.address;
  } else {
    const a = values.address ? toAddress(values.address) : cfg.walletAddress;
    if (!a) throw new Error('pass --address or set WALLET_ADDRESS');
    wallet = a;
  }

  const sleeves: SleeveDeps = {
    cfg,
    rpc,
    jupiter,
    wallet,
    signer,
    router: policy,
    maxPriorityFeeLamports: botPolicy.maxPriorityFeeLamports,
    rentTokenAccount: rent,
    isHalted: cfg.isHalted,
    log: err,
  };
  const store = new RouterStore(routerStorePath);

  if (cmd === 'regime' || cmd === 'plan') {
    const router = new Router({ sleeves, policy, botPolicy, prices, feed, store, momentumState, now: () => Date.now() });
    const before = router.state().tracker.active;
    const report = await router.step({ commit: false });
    if (values.json) {
      out(JSON.stringify(report, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
      return 0;
    }
    printEvaluation(report.evaluation, policy, before);
    if (cmd === 'plan') {
      printPlan(report, policy);
      out('Dry run only: nothing was signed and the regime tracker did not advance.');
    }
    return 0;
  }

  if (cmd !== 'run') {
    err(`unknown auto command "${cmd}"\n\n${AUTO_HELP}`);
    return 3;
  }

  const release = acquireLock(resolve(dataDir, 'trader.lock'), 'auto run');
  try {
    const genesis = await rpc.getGenesisHash();
    if (genesis !== GENESIS_HASHES[cfg.policy.cluster]) throw new Error(`RPC is not ${cfg.policy.cluster} (genesis ${genesis}); refusing to trade`);
    out('Pre-flight: simulating a 0.001 SOL -> USDC swap through the swap firewall…');
    await executeSwap(
      { rpc, jupiter, wallet, signer: null, maxPriorityFeeLamports: botPolicy.maxPriorityFeeLamports, rentTokenAccount: rent, isHalted: cfg.isHalted, log: err },
      { inputMint: WSOL_MINT, outputMint: policy.hedge.mint, inputTokenProgram: TOKEN_PROGRAM_ID, outputTokenProgram: TOKEN_PROGRAM_ID, amount: 1_000_000n, slippageBps: policy.hedge.slippageBps, maxPriceImpactPct: 5 },
    );
    const engine = new Engine({
      policy: botPolicy,
      feed,
      market: jupiter,
      rpc,
      broker: new LiveBroker({ rpc, jupiter, wallet, signer, maxPriorityFeeLamports: botPolicy.maxPriorityFeeLamports, rentTokenAccount: rent, isHalted: cfg.isHalted, log: err }, botPolicy),
      store: botLiveStore,
      events: new EventLog(resolve(dataDir, 'bot-live-events.jsonl')),
      wallet,
      rentTokenAccount: rent,
      isHalted: cfg.isHalted,
      log: out,
      now: () => Date.now(),
    });
    await engine.loadOrInit(null);
    const router = new Router({
      sleeves,
      policy,
      botPolicy,
      prices,
      feed,
      store,
      momentumState,
      momentumExit: async () => {
        const r = await engine.liquidate();
        return [...r.actions, ...r.notes].join('; ') || 'nothing to sell';
      },
      now: () => Date.now(),
    });
    const sol = await rpc.getBalance(wallet);
    const ok =
      values.yes ||
      (await (async () => {
        if (!process.stdin.isTTY) throw new Error('refusing without confirmation: run interactively or pass --yes');
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          const answer = await rl.question(
            `LIVE strategy switching for ${wallet} (${s4(sol)} SOL liquid), profile "${policy.profile}".\n` +
              'It will stake, unstake, swap SOL<->USDC and run the memecoin bot as market conditions change.\n' +
              'Type "yes" to proceed: ',
          );
          return answer.trim().toLowerCase() === 'yes';
        } finally {
          rl.close();
        }
      })());
    if (!ok) {
      out('Aborted.');
      return 1;
    }
    let stopping = false;
    const stop = () => {
      if (!stopping) out('stopping after the current step…');
      stopping = true;
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    while (!stopping) {
      try {
        const st = router.state();
        if (values.once || Date.now() - st.lastEvaluatedAt >= policy.switching.evaluateMinutes * 60_000) {
          const before = st.tracker.active;
          const report = await router.step({ commit: true });
          printEvaluation(report.evaluation, policy, before);
          printPlan(report, policy);
        }
        const now = router.state();
        const held = momentumState()?.positions.length ?? 0;
        if (now.momentum.allowEntries || held > 0) {
          const r = await engine.tick({ ...(values.once ? { forceScan: true } : {}), budget: { allowEntries: now.momentum.allowEntries, maxExposureLamports: BigInt(now.momentum.maxExposureLamports) } });
          for (const n of r.notes) err(`  note: ${n}`);
        }
      } catch (e) {
        err(`cycle failed: ${(e as Error).message}`);
      }
      if (values.once) break;
      for (let waited = 0; waited < botPolicy.tickIntervalSeconds * 1000 && !stopping; waited += 1000) await new Promise((r) => setTimeout(r, 1000));
    }
    return 0;
  } finally {
    release();
    signer?.destroy();
  }
}
