// `solprofits bot <command>` — the high-risk memecoin momentum bot.

import { readFileSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../config.ts';
import { GENESIS_HASHES, TOKEN_ACCOUNT_SIZE, TOKEN_PROGRAM_ID } from '../solana/constants.ts';
import { Rpc } from '../solana/rpc.ts';
import { loadSignerFromEnv, toAddress, type Address, type Signer } from '../crypto/keys.ts';
import { formatSol, parseSol } from '../util/amount.ts';
import { Engine, EventLog, LiveBroker, PaperBroker, type Broker, type Market } from './engine.ts';
import { JupiterTokenFeed, type TokenFeed } from './feed.ts';
import { DEFAULT_JUPITER_URL, JupiterClient, WSOL_MINT } from './jupiter.ts';
import { parseBotPolicy, type BotPolicy } from './policy.ts';
import { checkMintAccount } from './safety.ts';
import { StateStore, type BotState } from './state.ts';
import { rankCandidates, scoreToken } from './strategy.ts';
import { executeSwap, SwapRejected, type SwapContext } from './swap.ts';

export const BOT_HELP = `solprofits bot — HIGH-RISK memecoin momentum bot (expect to lose money; see docs/MEMECOIN_BOT.md)

  bot scan                      Show today's candidates and why others were rejected (read-only)
  bot selfcheck [--address A]   Verify RPC, Jupiter API formats and the swap firewall against live data
  bot paper [--once] [--reset] [--start-sol 1]
                                Paper-trade with live market data; no key, nothing is signed
  bot run --execute [--yes] [--once]
                                LIVE trading with the wallet's SOL (key via SOLANA_KEYPAIR_PATH / SOLANA_KEYPAIR)
  bot status [--paper]          Positions, closed trades and P&L from the saved state
  bot liquidate [--paper] --execute [--yes]
                                Sell every position back to SOL now

Environment: SOLANA_RPC_URL, JUPITER_API_URL (default ${DEFAULT_JUPITER_URL}), JUPITER_API_KEY,
             SOLPROFITS_BOT_POLICY, SOLPROFITS_DATA_DIR, SOLPROFITS_HALT=1 (kill switch)`;

export const USDC_MINT = toAddress('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

interface BotDeps {
  rpc: Rpc;
  jupiter: JupiterClient;
  feed: TokenFeed;
  policy: BotPolicy;
  dataDir: string;
  isHalted: () => boolean;
  cluster: keyof typeof GENESIS_HASHES;
  walletAddress: Address | null;
}

function setup(env: NodeJS.ProcessEnv): BotDeps {
  const cfg = loadConfig(env);
  const policyPath = env.SOLPROFITS_BOT_POLICY ?? resolve(cfg.repoRoot, 'config/bot-policy.json');
  const policy = parseBotPolicy(JSON.parse(readFileSync(policyPath, 'utf8')));
  const jupUrl = env.JUPITER_API_URL?.trim() || DEFAULT_JUPITER_URL;
  const key = env.JUPITER_API_KEY?.trim() || undefined;
  return {
    rpc: new Rpc(cfg.rpcUrl),
    jupiter: new JupiterClient(jupUrl, key),
    feed: new JupiterTokenFeed(jupUrl, key),
    policy,
    dataDir: env.SOLPROFITS_DATA_DIR ?? resolve(cfg.repoRoot, 'data'),
    isHalted: cfg.isHalted,
    cluster: cfg.policy.cluster,
    walletAddress: cfg.walletAddress,
  };
}

const out = (l = '') => process.stdout.write(l + '\n');
const err = (l: string) => process.stderr.write(l + '\n');

async function confirm(prompt: string, yes: boolean): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY) throw new Error('refusing without confirmation: run interactively or pass --yes');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(`${prompt}\nType "yes" to proceed: `)).trim().toLowerCase() === 'yes';
  } finally {
    rl.close();
  }
}

function printState(s: BotState): void {
  const start = BigInt(s.startEquityLamports);
  out(`${s.mode.toUpperCase()} bot for ${s.wallet}, started ${new Date(s.startedAt).toISOString()} with ${formatSol(start, 4)} SOL`);
  if (s.paperSolLamports !== null) out(`  paper SOL balance: ${formatSol(BigInt(s.paperSolLamports), 6)}`);
  let open = 0n;
  for (const p of s.positions) {
    const value = BigInt(p.lastValueLamports) + BigInt(p.realizedLamports);
    const pnl = (Number(value) / Number(BigInt(p.costLamports)) - 1) * 100;
    open += BigInt(p.lastValueLamports);
    out(`  open  ${p.symbol.padEnd(10)} cost ${formatSol(BigInt(p.costLamports), 4)} SOL  now ${formatSol(BigInt(p.lastValueLamports), 4)} SOL  P&L ${pnl.toFixed(1)}%${p.takeProfitDone ? '  (half sold at target, trailing the rest)' : ''}`);
  }
  const closed = s.closed;
  const wins = closed.filter((c) => BigInt(c.proceedsLamports) > BigInt(c.costLamports)).length;
  const net = closed.reduce((a, c) => a + BigInt(c.proceedsLamports) - BigInt(c.costLamports), 0n);
  out(`  closed trades: ${closed.length} (${wins} winners), realized ${net >= 0n ? '+' : ''}${formatSol(net, 4)} SOL`);
  for (const c of closed.slice(-10)) {
    const r = (Number(BigInt(c.proceedsLamports)) / Number(BigInt(c.costLamports)) - 1) * 100;
    out(`    ${new Date(c.closedAt).toISOString().slice(0, 16)} ${c.symbol.padEnd(10)} ${r >= 0 ? '+' : ''}${r.toFixed(1)}%  ${c.reason}`);
  }
  if (s.paperSolLamports !== null) {
    const equity = BigInt(s.paperSolLamports) + open;
    out(`  equity (last tick): ${formatSol(equity, 4)} SOL (${((Number(equity) / Number(start) - 1) * 100).toFixed(1)}% since start)`);
  }
}

/** The startup gate for live trading: a simulated SOL -> USDC swap must pass the firewall and simulation. */
async function swapGate(d: BotDeps, wallet: Address, rent: bigint): Promise<string[]> {
  const ctx: SwapContext = { rpc: d.rpc, jupiter: d.jupiter, wallet, signer: null, maxPriorityFeeLamports: d.policy.maxPriorityFeeLamports, rentTokenAccount: rent, isHalted: d.isHalted, log: err };
  const r = await executeSwap(ctx, {
    inputMint: WSOL_MINT,
    outputMint: USDC_MINT,
    inputTokenProgram: TOKEN_PROGRAM_ID,
    outputTokenProgram: TOKEN_PROGRAM_ID,
    amount: 1_000_000n,
    slippageBps: 100,
    maxPriceImpactPct: 5,
  });
  return r.actions;
}

export async function botMain(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      address: { type: 'string' },
      execute: { type: 'boolean' },
      yes: { type: 'boolean' },
      once: { type: 'boolean' },
      reset: { type: 'boolean' },
      paper: { type: 'boolean' },
      json: { type: 'boolean' },
      'start-sol': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const cmd = positionals[0] ?? 'help';
  if (cmd === 'help' || values.help) {
    out(BOT_HELP);
    return 0;
  }
  const d = setup(env);
  const paperStore = new StateStore(resolve(d.dataDir, 'bot-paper-state.json'));
  const liveStore = new StateStore(resolve(d.dataDir, 'bot-live-state.json'));

  if (cmd === 'status') {
    const store = values.paper ? paperStore : liveStore;
    if (!store.exists()) {
      out(`no ${values.paper ? 'paper' : 'live'} bot state yet (${store.path})`);
      return 0;
    }
    printState(store.load());
    return 0;
  }

  if (cmd === 'scan') {
    const tokens = await d.feed.trending();
    const { passed, rejected } = rankCandidates(tokens, d.policy, Date.now(), new Set());
    out(`${tokens.length} trending tokens screened via ${d.jupiter.host}: ${passed.length} pass the filters`);
    const reasons = new Map<string, number>();
    for (const r of rejected) {
      const key = (r.reasons[0] ?? '?').replace(/[\d$.,%]+/g, '#');
      reasons.set(key, (reasons.get(key) ?? 0) + 1);
    }
    for (const [k, v] of [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 8)) out(`  rejected ${String(v).padStart(3)} × ${k}`);
    const size = parseSol(values['start-sol'] ?? '1') * BigInt(Math.round(d.policy.positionFraction * 1000)) / 1000n;
    for (const t of passed.slice(0, 5)) {
      const check = checkMintAccount(t.mint, await d.rpc.getAccountInfo(t.mint));
      let quoteInfo = '';
      try {
        const buy = await d.jupiter.quote({ inputMint: WSOL_MINT, outputMint: t.mint, amount: size, slippageBps: d.policy.buySlippageBps });
        const back = await d.jupiter.quote({ inputMint: t.mint, outputMint: WSOL_MINT, amount: buy.outAmount, slippageBps: d.policy.sellSlippageBps });
        quoteInfo = `impact ${buy.priceImpactPct.toFixed(2)}%, round trip ${((1 - Number(back.outAmount) / Number(size)) * 100).toFixed(2)}%`;
      } catch (e) {
        quoteInfo = `no quote (${(e as Error).message})`;
      }
      out(
        `  ${check.ok ? 'PASS' : 'FAIL'} ${t.symbol.padEnd(10)} ${t.mint}  score ${scoreToken(t).toFixed(2)}  1h ${t.stats1h.priceChangePct?.toFixed(0)}%  liq $${Math.round(t.liquidityUsd ?? 0)}  holders ${t.holderCount}  ${quoteInfo}${check.ok ? '' : `  [${check.reasons.join('; ')}]`}`,
      );
    }
    return 0;
  }

  const rent = await d.rpc.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_SIZE);

  if (cmd === 'selfcheck') {
    let failures = 0;
    const check = (ok: boolean, label: string, detail = '') => {
      out(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
      if (!ok) failures++;
    };
    out('Bot self-check');
    const genesis = await d.rpc.getGenesisHash();
    check(genesis === GENESIS_HASHES[d.cluster], `RPC is ${d.cluster}`, genesis);
    try {
      const q = await d.jupiter.quote({ inputMint: WSOL_MINT, outputMint: USDC_MINT, amount: 10_000_000n, slippageBps: 50 });
      check(q.outAmount > 0n, `Jupiter quote API (${d.jupiter.host}) parses`, `0.01 SOL ≈ ${Number(q.outAmount) / 1e6} USDC, impact field ${String(q.raw.priceImpactPct)}`);
    } catch (e) {
      check(false, 'Jupiter quote API', (e as Error).message);
    }
    try {
      const tokens = await d.feed.trending();
      const withStats = tokens.filter((t) => t.liquidityUsd !== null && t.stats1h.priceChangePct !== null && t.holderCount !== null).length;
      check(tokens.length > 0 && withStats > tokens.length / 2, 'token feed parses with market stats', `${tokens.length} tokens, ${withStats} with liquidity/1h/holder data`);
    } catch (e) {
      check(false, 'token feed', (e as Error).message);
    }
    const wallet = values.address ? toAddress(values.address) : d.walletAddress;
    if (wallet) {
      try {
        const actions = await swapGate(d, wallet, rent);
        check(true, 'real Jupiter swap transaction passes the swap firewall and simulation', actions.join('; '));
      } catch (e) {
        check(false, 'swap firewall + simulation on a real Jupiter transaction', (e as Error).message);
      }
    } else {
      out('  · pass --address (a funded wallet) to verify the swap firewall on a real Jupiter transaction');
    }
    out(failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED — do not run live until resolved.`);
    return failures === 0 ? 0 : 2;
  }

  const market: Market = d.jupiter;
  let signer: Signer | null = null;
  let broker: Broker;
  let store: StateStore;
  let wallet: Address;
  const paper = cmd === 'paper' || (cmd === 'liquidate' && values.paper);
  try {
    if (paper) {
      wallet = values.address ? toAddress(values.address) : d.walletAddress ?? toAddress('11111111111111111111111111111111');
      store = paperStore;
      if (values.reset && store.exists()) rmSync(store.path);
      broker = new PaperBroker(market, d.policy, rent);
    } else if (cmd === 'run' || cmd === 'liquidate') {
      if (!values.execute) {
        err(`"bot ${cmd}" trades real SOL and needs --execute. To simulate with live data and no key, use "bot paper".`);
        return 3;
      }
      if (d.isHalted()) throw new Error('kill switch is active (HALT file or SOLPROFITS_HALT=1)');
      const loaded = loadSignerFromEnv(env);
      signer = loaded.signer;
      for (const w of loaded.warnings) err(`warning: ${w}`);
      if (d.walletAddress && d.walletAddress !== signer.address) throw new Error(`signing key ${signer.address} does not match WALLET_ADDRESS ${d.walletAddress}`);
      wallet = signer.address;
      const genesis = await d.rpc.getGenesisHash();
      if (genesis !== GENESIS_HASHES[d.cluster]) throw new Error(`RPC is not ${d.cluster} (genesis ${genesis}); refusing to trade`);
      store = liveStore;
      const ctx: SwapContext = { rpc: d.rpc, jupiter: d.jupiter, wallet, signer, maxPriorityFeeLamports: d.policy.maxPriorityFeeLamports, rentTokenAccount: rent, isHalted: d.isHalted, log: err };
      broker = new LiveBroker(ctx, d.policy);
      if (cmd === 'run') {
        out('Pre-flight: simulating a 0.001 SOL -> USDC swap through the firewall…');
        try {
          await swapGate(d, wallet, rent);
        } catch (e) {
          throw new Error(`pre-flight failed, refusing to trade: ${(e as Error).message}`);
        }
        const sol = await d.rpc.getBalance(wallet);
        const ok = await confirm(
          `LIVE memecoin trading with ${formatSol(sol, 4)} SOL from ${wallet}.\n` +
            `Up to ${d.policy.maxOpenPositions} positions of ${Math.round(d.policy.positionFraction * 100)}% of equity; stop-loss ${d.policy.stopLossPct}%, ` +
            `take ${Math.round(d.policy.takeProfitSellFraction * 100)}% profit at +${d.policy.takeProfitPct}%, no new buys below ${formatSol(d.policy.equityFloorLamports)} SOL.\n` +
            'Most likely outcome: losing money. Stop anytime with Ctrl-C; "touch HALT" stops all signing.',
          Boolean(values.yes),
        );
        if (!ok) {
          out('Aborted.');
          return 1;
        }
      } else if (!(await confirm('Sell EVERY bot position back to SOL now?', Boolean(values.yes)))) {
        out('Aborted.');
        return 1;
      }
    } else {
      err(`unknown bot command "${cmd}"\n\n${BOT_HELP}`);
      return 3;
    }

    const engine = new Engine({
      policy: d.policy,
      feed: d.feed,
      market,
      rpc: d.rpc,
      broker,
      store,
      events: new EventLog(resolve(d.dataDir, `bot-${broker.mode}-events.jsonl`)),
      wallet,
      rentTokenAccount: rent,
      isHalted: d.isHalted,
      log: out,
      now: () => Date.now(),
    });
    await engine.loadOrInit(paper ? parseSol(values['start-sol'] ?? '1') : null);

    if (cmd === 'liquidate') {
      const r = await engine.liquidate();
      for (const a of r.actions) out(a);
      for (const n of r.notes) err(n);
      return r.notes.some((n) => /did not confirm|error|refused/i.test(n)) ? 2 : 0;
    }
    if (values.once) {
      const r = await engine.tick({ forceScan: true });
      for (const n of r.notes) err(`  note: ${n}`);
      return 0;
    }
    let stopping = false;
    const stop = () => {
      if (!stopping) out('stopping after the current step…');
      stopping = true;
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    let failures = 0;
    while (!stopping) {
      try {
        const r = await engine.tick();
        for (const n of r.notes) err(`  note: ${n}`);
        failures = 0;
      } catch (e) {
        failures++;
        err(`tick failed (${failures} in a row): ${(e as Error).message}`);
      }
      const wait = Math.min(300_000, d.policy.tickIntervalSeconds * 1000 * Math.max(1, failures));
      for (let waited = 0; waited < wait && !stopping; waited += 1000) await new Promise((r) => setTimeout(r, 1000));
    }
    return 0;
  } catch (e) {
    if (e instanceof SwapRejected) err(`refused: ${e.message}`);
    else err(`error: ${(e as Error).message}`);
    return 3;
  } finally {
    signer?.destroy();
  }
}

