#!/usr/bin/env node
// solprofits — grow a SOL balance by liquid staking, with guardrails.
// Every command is read-only unless `--execute` is passed.

import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { loadConfig, type AppConfig } from './config.ts';
import { loadChainContext, type ChainContext } from './core/chain.ts';
import { ExecutionError, prepare, signAndSend, type ExecContext, type PreparedTransaction, type SendOutcome } from './core/executor.ts';
import { Ledger, trailingApy, type SnapshotEntry } from './core/ledger.ts';
import { runMonitor } from './core/monitor.ts';
import {
  planDeposit,
  planWithdraw,
  priorityFeeLamports,
  selectDepositPool,
  selectWithdrawPosition,
  type DepositPlan,
  type NoopPlan,
  type WithdrawPlan,
} from './core/planner.ts';
import { evaluatePools, inspectPrograms, rankPools, type PoolEvaluation } from './core/pools.ts';
import { loadPortfolio, type Portfolio } from './core/portfolio.ts';
import { loadSignerFromEnv, toAddress, type Address, type Signer } from './crypto/keys.ts';
import { deriveWithdrawAuthority } from './solana/programs.ts';
import { Rpc } from './solana/rpc.ts';
import { formatSol, formatUnits, parseSol, parseUnits } from './util/amount.ts';

const HELP = `solprofits — grow a SOL balance by liquid staking, with guardrails

Read-only (need only a public address: --address or WALLET_ADDRESS):
  status      Wallet value in SOL, positions and pool health; records a ledger snapshot
  pools       Verify and rank the allowlisted stake pools
  plan        Show and simulate exactly what a deposit would do (no key needed)
  monitor     Health checks for schedulers; exit code 0 ok, 1 warning, 2 critical
  selfcheck   Verify RPC, cluster, program and decoder consistency on the live chain

Actions (simulation only unless --execute; key via SOLANA_KEYPAIR_PATH or SOLANA_KEYPAIR):
  deposit   [--pool SYM] [--amount SOL]             Stake idle SOL, keeping the fee reserve
  withdraw  [--pool SYM] [--amount TOKENS | --all]  Redeem pool tokens for SOL (instant)

High-risk memecoin bot (separate module, see docs/MEMECOIN_BOT.md):
  bot …       run "solprofits bot help" for its commands (scan, selfcheck, paper, run, status, liquidate)

Options:
  --address ADDR   wallet public address for read-only commands
  --pool SYM       use a specific allowlisted pool (e.g. JitoSOL)
  --amount X       decimal SOL (deposit) or pool tokens (withdraw)
  --all            withdraw the whole position (default when --amount is absent)
  --keep-account   withdraw: keep the emptied token account open
  --execute        sign and send; without it nothing is ever signed
  --yes            skip the interactive confirmation (automation)
  --json           machine-readable output
  --no-ledger      do not record a ledger snapshot
`;

type Values = {
  address?: string;
  pool?: string;
  amount?: string;
  all?: boolean;
  'keep-account'?: boolean;
  execute?: boolean;
  yes?: boolean;
  json?: boolean;
  'no-ledger'?: boolean;
  help?: boolean;
};

class UsageError extends Error {}

const out = (line = ''): void => {
  process.stdout.write(line + '\n');
};
const err = (line: string): void => {
  process.stderr.write(line + '\n');
};

function jsonReplacer(_k: string, v: unknown): unknown {
  return typeof v === 'bigint' ? v.toString() : v;
}

function printJson(value: unknown): void {
  out(JSON.stringify(value, jsonReplacer, 2));
}

const pct = (x: number | null | undefined, digits = 2): string => (x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(digits)}%`);
const sol = (l: bigint, digits = 6): string => `${formatSol(l, digits)} SOL`;

// ---------------------------------------------------------------- shared loading

interface World {
  chain: ChainContext;
  evaluations: PoolEvaluation[];
  portfolio: Portfolio | null;
}

async function loadWorld(cfg: AppConfig, rpc: Rpc, wallet: Address | null): Promise<World> {
  const chain = await loadChainContext(rpc, cfg.policy);
  const evaluations = await evaluatePools(rpc, cfg.pools, chain, cfg.policy);
  const portfolio = wallet ? await loadPortfolio(rpc, wallet, evaluations) : null;
  return { chain, evaluations, portfolio };
}

function readOnlyWallet(cfg: AppConfig, values: Values, required: boolean): Address | null {
  const raw = values.address ?? cfg.walletAddress ?? null;
  if (!raw) {
    if (required) throw new UsageError('wallet address required: pass --address <ADDR> or set WALLET_ADDRESS');
    return null;
  }
  return toAddress(raw);
}

function snapshotOf(world: World): SnapshotEntry | null {
  const p = world.portfolio;
  if (!p) return null;
  return {
    type: 'snapshot',
    ts: new Date().toISOString(),
    epoch: world.chain.epoch.toString(),
    wallet: p.wallet,
    solLamports: p.solLamports.toString(),
    totalValueLamports: p.totalValueLamports.toString(),
    positions: p.positions
      .filter((x) => x.exists)
      .map((x) => ({ symbol: x.evaluation.config.symbol, tokens: x.tokens.toString(), valueLamports: x.valueLamports.toString(), rate: x.evaluation.metrics?.rate ?? 0 })),
    rates: world.evaluations.flatMap((e) =>
      e.verified
        ? [{ symbol: e.config.symbol, epoch: e.verified.pool.lastUpdateEpoch.toString(), totalLamports: e.verified.pool.totalLamports.toString(), poolTokenSupply: e.verified.pool.poolTokenSupply.toString() }]
        : [],
    ),
  };
}

// ---------------------------------------------------------------- printers

function printChain(chain: ChainContext, rpc: Rpc): void {
  const progress = Number((chain.slotIndex * 1000n) / (chain.slotsInEpoch || 1n)) / 10;
  out(`RPC ${rpc.displayUrl} · ${chain.clusterVerified ? 'cluster verified' : 'CLUSTER MISMATCH (genesis ' + chain.genesisHash + ')'} · epoch ${chain.epoch} (${progress.toFixed(1)}% done) · ~${chain.epochsPerYear.toFixed(0)} epochs/yr`);
}

function printPools(evaluations: PoolEvaluation[], ledgerSnaps: SnapshotEntry[], chain: ChainContext): void {
  out('');
  out('Pools (ranked; APY = last epoch, compounded, net of the pool\'s reward fee):');
  for (const e of rankPools(evaluations)) {
    const m = e.metrics;
    const status = !e.verified ? 'UNVERIFIED' : e.depositable ? 'ok' : 'not depositable';
    if (!m) {
      out(`  ${e.config.symbol.padEnd(8)} ${status}`);
    } else {
      const trail = trailingApy(ledgerSnaps, e.config.symbol, chain.epochsPerYear);
      out(
        `  ${e.config.symbol.padEnd(8)} ${status.padEnd(16)} APY ${pct(m.apyEstimate).padStart(7)}` +
          `${trail ? ` (trailing ${trail.epochs} ep: ${pct(trail.apy)})` : ''}` +
          `  TVL ${formatSol(m.tvlLamports, 0)} SOL  reward fee ${m.epochFeePct.toFixed(1)}%` +
          `  deposit fee ${m.solDepositFeeBps.toFixed(1)}bp  instant-exit fee ${m.solWithdrawalFeeBps.toFixed(1)}bp` +
          `  rate ${m.rate.toFixed(6)}`,
      );
    }
    for (const i of e.issues) out(`      [${i.level}] ${i.message}`);
  }
}

function printPortfolio(p: Portfolio, snaps: SnapshotEntry[]): void {
  out('');
  out(`Wallet ${p.wallet}${p.walletExists ? '' : ' (no account yet: unfunded)'}`);
  out(`  liquid SOL        ${sol(p.solLamports, 9)}`);
  for (const pos of p.positions.filter((x) => x.exists)) {
    const dec = pos.evaluation.verified?.mint.decimals ?? 9;
    out(`  ${pos.evaluation.config.symbol.padEnd(17)} ${formatUnits(pos.tokens, dec)} tokens = ${sol(pos.valueLamports, 9)} (+ ${sol(pos.ataLamports, 6)} account rent)`);
    for (const i of pos.issues) out(`      [${i.level}] ${i.message}`);
  }
  for (const i of p.issues) out(`  [${i.level}] ${i.message}`);
  out(`  TOTAL VALUE       ${sol(p.totalValueLamports, 9)}`);
  const first = snaps[0];
  if (first) {
    const base = BigInt(first.totalValueLamports);
    const delta = p.totalValueLamports - base;
    out(`  since ${first.ts.slice(0, 10)}: ${delta >= 0n ? '+' : ''}${formatSol(delta, 9)} SOL (${base > 0n ? ((Number(delta) / Number(base)) * 100).toFixed(3) : '0'}%)`);
  }
}

function printDepositPlan(plan: DepositPlan): void {
  const sym = plan.evaluation.config.symbol;
  const dec = plan.verified.mint.decimals;
  out('');
  out(`Deposit plan → ${sym} (${plan.evaluation.config.name})`);
  out(`  deposit              ${sol(plan.lamports, 9)}`);
  out(`  you receive          ${formatUnits(plan.receivedTokens, dec)} ${sym} (worth ${sol(plan.receivedValueLamports, 9)} at the pool rate)`);
  out(`  on-chain minimum     ${formatUnits(plan.minPoolTokensOut, dec)} ${sym} — the program reverts the deposit if it would mint less`);
  out(`  entry cost           ${sol(plan.entryCostLamports, 9)} (${plan.entryCostBps.toFixed(2)} bps: pool deposit fee + rounding)`);
  out(`  wallet keeps         ≥ ${sol(plan.solAfterLamports, 6)} liquid for fees`);
  const apy = plan.evaluation.metrics?.apyEstimate;
  if (apy !== null && apy !== undefined) {
    out(`  expected growth      ~${sol(BigInt(Math.floor(Number(plan.receivedValueLamports) * apy)), 6)}/year at ${pct(apy)} (variable, not guaranteed)`);
  }
  for (const n of plan.notes) out(`  note: ${n}`);
}

function printWithdrawPlan(plan: WithdrawPlan): void {
  const sym = plan.evaluation.config.symbol;
  const dec = plan.verified.mint.decimals;
  out('');
  out(`Withdraw plan ← ${sym}`);
  out(`  redeem               ${formatUnits(plan.poolTokens, dec)} ${sym}`);
  out(`  you receive          ${sol(plan.quote.lamportsOut, 9)}${plan.closeAta ? ` + ${sol(plan.ataRentLamports, 6)} rent refund` : ''}`);
  out(`  on-chain minimum     ${sol(plan.minLamportsOut, 9)} — the program reverts if it would pay less`);
  out(`  exit cost            ${sol(plan.exitCostLamports, 9)} (${plan.exitCostBps.toFixed(2)} bps instant-withdrawal fee)`);
  for (const n of plan.notes) out(`  note: ${n}`);
}

function printPrepared(p: PreparedTransaction): void {
  out('');
  out(`Simulated against the live chain (${p.guarded ? 'slippage-guarded instruction' : 'LEGACY unguarded instruction'}):`);
  for (const c of p.checks) out(`  ✓ ${c}`);
  out(`  ✓ firewall: ${p.firewall.actions.join('; ')}`);
  out(`  compute ${p.unitsConsumed ?? '?'} units (limit ${p.compute.unitLimit}), priority fee ${formatSol(priorityFeeLamports(p.compute), 9)} SOL + 0.000005 SOL base fee`);
}

function printNoop(plan: NoopPlan): void {
  out('');
  out('Nothing to do:');
  for (const r of plan.reasons) out(`  - ${r}`);
}

// ---------------------------------------------------------------- execution

async function confirmInteractively(prepared: PreparedTransaction, values: Values): Promise<boolean> {
  if (values.yes) return true;
  if (!process.stdin.isTTY) throw new UsageError('refusing to sign without confirmation: run interactively or pass --yes');
  out('');
  out('About to SIGN and SEND a mainnet transaction that will:');
  for (const a of prepared.firewall.actions) out(`  • ${a}`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('Type "yes" to proceed: ');
    return answer.trim().toLowerCase() === 'yes';
  } finally {
    rl.close();
  }
}

function loadSigner(cfg: AppConfig, values: Values): Signer {
  const { signer, source, warnings } = loadSignerFromEnv();
  for (const w of warnings) err(`warning: ${w}`);
  const expected = values.address ?? cfg.walletAddress;
  if (expected && expected !== signer.address) {
    signer.destroy();
    throw new UsageError(`signing key (${signer.address}) does not match the configured wallet address (${expected})`);
  }
  err(`signing key loaded from ${source} for ${signer.address}`);
  return signer;
}

async function executeAction(
  cfg: AppConfig,
  rpc: Rpc,
  values: Values,
  kind: 'deposit' | 'withdraw',
): Promise<number> {
  const execute = Boolean(values.execute);
  let signer: Signer | null = null;
  try {
    if (execute) {
      if (cfg.isHalted()) throw new UsageError('kill switch is active (HALT file or SOLPROFITS_HALT=1)');
      signer = loadSigner(cfg, values);
    }
    const wallet = signer ? signer.address : readOnlyWallet(cfg, values, true)!;
    const ledger = new Ledger(cfg.ledgerPath);
    const maxAttempts = execute ? 3 : 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const world = await loadWorld(cfg, rpc, wallet);
      if (!values.json) printChain(world.chain, rpc);
      if (execute && !world.chain.clusterVerified) throw new UsageError(`RPC is not ${cfg.policy.cluster} (genesis ${world.chain.genesisHash}); refusing to sign`);
      const portfolio = world.portfolio!;

      let plan: DepositPlan | WithdrawPlan | NoopPlan;
      if (kind === 'deposit') {
        const chosen = selectDepositPool(world.evaluations, portfolio, cfg.policy, values.pool);
        plan =
          'kind' in chosen
            ? chosen
            : planDeposit({
                portfolio,
                evaluation: chosen,
                policy: cfg.policy,
                rentTokenAccount: world.chain.rentTokenAccount,
                ...(values.amount ? { requestedLamports: parseSol(values.amount) } : {}),
              });
      } else {
        const pos = selectWithdrawPosition(portfolio, values.pool);
        if ('kind' in pos) {
          plan = pos;
        } else {
          const dec = pos.evaluation.verified?.mint.decimals ?? 9;
          plan = planWithdraw({
            portfolio,
            position: pos,
            policy: cfg.policy,
            ...(values.amount && !values.all ? { requestedTokens: parseUnits(values.amount, dec) } : {}),
            closeWhenEmpty: !values['keep-account'],
          });
        }
      }

      if (plan.kind === 'noop') {
        if (values.json) printJson({ plan });
        else printNoop(plan);
        return 0;
      }
      if (!values.json) plan.kind === 'deposit' ? printDepositPlan(plan) : printWithdrawPlan(plan);

      const ctx: ExecContext = { rpc, policy: cfg.policy, evaluations: world.evaluations, log: (l) => err(l) };
      const prepared = await prepare(ctx, plan);
      if (values.json && !execute) {
        printJson({ plan, simulation: { checks: prepared.checks, actions: prepared.firewall.actions, compute: prepared.compute, guarded: prepared.guarded } });
        return 0;
      }
      if (!values.json) printPrepared(prepared);
      if (!execute) {
        out('');
        out('Dry run only: nothing was signed. Re-run with --execute to sign and send.');
        return 0;
      }

      if (!(await confirmInteractively(prepared, values))) {
        out('Aborted; nothing was signed.');
        return 1;
      }
      const outcome: SendOutcome = await signAndSend(ctx, prepared, signer!, cfg.isHalted);
      ledger.append({
        type: 'action',
        ts: new Date().toISOString(),
        action: kind,
        status: outcome.status,
        signature: outcome.signature,
        wallet,
        pool: plan.evaluation.config.symbol,
        detail:
          plan.kind === 'deposit'
            ? { lamports: plan.lamports.toString(), expectedTokens: plan.receivedTokens.toString(), minTokens: plan.minPoolTokensOut.toString() }
            : { poolTokens: plan.poolTokens.toString(), expectedLamports: plan.quote.lamportsOut.toString(), minLamports: plan.minLamportsOut.toString() },
      });
      if (outcome.status === 'expired') {
        err(`attempt ${attempt}: transaction expired without landing (it can no longer execute); re-planning from fresh state…`);
        continue;
      }
      if (outcome.status === 'failed') {
        err(`transaction failed: ${outcome.error}`);
        for (const l of outcome.logs.slice(-15)) err(`  ${l}`);
        return 2;
      }
      if (outcome.status === 'unknown') {
        err(`OUTCOME UNKNOWN for ${outcome.signature}: ${outcome.error}`);
        return 2;
      }
      out('');
      out(`✓ confirmed in slot ${outcome.slot}: https://explorer.solana.com/tx/${outcome.signature}`);
      const after = await loadWorld(cfg, rpc, wallet);
      const snap = snapshotOf(after);
      if (snap) ledger.append(snap);
      printPortfolio(after.portfolio!, ledger.snapshots(wallet));
      return 0;
    }
    err('gave up after repeated expirations; network may be congested. Nothing further was sent.');
    return 2;
  } finally {
    signer?.destroy();
  }
}

// ---------------------------------------------------------------- selfcheck

async function selfcheck(cfg: AppConfig, rpc: Rpc, values: Values): Promise<number> {
  let failures = 0;
  const check = (ok: boolean, label: string, detail = ''): void => {
    out(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures++;
  };
  out(`Self-check against ${rpc.displayUrl}`);
  const chain = await loadChainContext(rpc, cfg.policy);
  check(chain.clusterVerified, `genesis hash matches ${cfg.policy.cluster}`, chain.genesisHash);
  check(chain.epochsPerYear > 100 && chain.epochsPerYear < 250, 'epoch timing is plausible', `${chain.epochsPerYear.toFixed(1)} epochs/yr, ${chain.avgSlotSeconds.toFixed(3)} s/slot`);
  const programs = await inspectPrograms(rpc, [...new Set(cfg.pools.map((p) => p.program))], chain);
  for (const p of programs) {
    check(p.ok, `stake pool program ${p.program} deployed`, p.lastDeploySlot !== null ? `last deploy slot ${p.lastDeploySlot}, upgrade authority ${p.upgradeAuthority ?? 'none (immutable)'}` : '');
  }
  const evaluations = await evaluatePools(rpc, cfg.pools, chain, cfg.policy);
  for (const e of evaluations) {
    const v = e.verified;
    check(v !== null, `${e.config.symbol}: identity verified on-chain`, v ? 'owner, mint, mint authority PDA, bump seed, freeze authority' : e.issues.map((i) => i.message).join('; '));
    if (!v) continue;
    const [pda] = deriveWithdrawAuthority(e.config.program, e.config.stakePool);
    check(pda === v.withdrawAuthority && v.mint.mintAuthority === pda, `${e.config.symbol}: decoded layout consistent (mint authority = derived PDA)`);
    check(v.mint.supply <= v.pool.poolTokenSupply, `${e.config.symbol}: decoded pool token supply matches mint`, `${v.pool.poolTokenSupply} vs mint ${v.mint.supply}`);
    check(v.pool.lastUpdateEpoch <= chain.epoch, `${e.config.symbol}: last update epoch is not in the future`, `${v.pool.lastUpdateEpoch}`);
    check(e.metrics?.lastEpochReturn === null || (e.metrics!.lastEpochReturn! >= 0 && e.metrics!.lastEpochReturn! < 0.01), `${e.config.symbol}: last-epoch return plausible`, pct(e.metrics?.apyEstimate));
  }
  const wallet = readOnlyWallet(cfg, values, false);
  if (wallet) {
    const portfolio = await loadPortfolio(rpc, wallet, evaluations);
    check(portfolio.issues.length === 0, `wallet ${wallet} is a plain system account`, sol(portfolio.solLamports, 9));
    const chosen = selectDepositPool(evaluations, portfolio, cfg.policy, values.pool);
    if (!('kind' in chosen)) {
      const plan = planDeposit({ portfolio, evaluation: chosen, policy: cfg.policy, rentTokenAccount: chain.rentTokenAccount });
      if (plan.kind === 'deposit') {
        try {
          const prepared = await prepare({ rpc, policy: cfg.policy, evaluations, log: (l) => err(l) }, plan);
          check(true, `deposit into ${chosen.config.symbol} simulates successfully and matches the exact quote`, prepared.checks.join('; '));
          check(prepared.guarded, 'deployed program supports the slippage-guarded instruction');
        } catch (e) {
          check(false, `deposit simulation for ${chosen.config.symbol}`, (e as Error).message);
        }
      } else {
        out(`  · deposit simulation skipped: ${plan.reasons.join('; ')}`);
      }
    }
  } else {
    out('  · pass --address (or WALLET_ADDRESS) to also simulate a deposit from your wallet');
  }
  out(failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED — do not use --execute until resolved.`);
  return failures === 0 ? 0 : 2;
}

// ---------------------------------------------------------------- main

export async function main(argv: string[]): Promise<number> {
  if (argv[0] === 'bot') {
    const { botMain } = await import('./bot/cli.ts');
    return botMain(argv.slice(1));
  }
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      address: { type: 'string' },
      pool: { type: 'string' },
      amount: { type: 'string' },
      all: { type: 'boolean' },
      'keep-account': { type: 'boolean' },
      execute: { type: 'boolean' },
      yes: { type: 'boolean' },
      json: { type: 'boolean' },
      'no-ledger': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  }) as { positionals: string[]; values: Values };
  const command = positionals[0] ?? 'help';
  if (values.help || command === 'help') {
    out(HELP);
    return 0;
  }
  const cfg = loadConfig();
  const rpc = new Rpc(cfg.rpcUrl);
  const ledger = new Ledger(cfg.ledgerPath);

  switch (command) {
    case 'status': {
      const wallet = readOnlyWallet(cfg, values, true)!;
      const world = await loadWorld(cfg, rpc, wallet);
      const snaps = ledger.snapshots(wallet);
      const snap = snapshotOf(world);
      if (snap && !values['no-ledger']) ledger.append(snap);
      if (values.json) {
        printJson(world);
        return 0;
      }
      printChain(world.chain, rpc);
      printPortfolio(world.portfolio!, snaps);
      printPools(world.evaluations, snaps, world.chain);
      return 0;
    }
    case 'pools': {
      const world = await loadWorld(cfg, rpc, null);
      if (values.json) {
        printJson(rankPools(world.evaluations));
        return 0;
      }
      printChain(world.chain, rpc);
      printPools(world.evaluations, readOnlyWallet(cfg, values, false) ? ledger.snapshots(readOnlyWallet(cfg, values, false)!) : [], world.chain);
      return 0;
    }
    case 'plan':
      return executeAction(cfg, rpc, { ...values, execute: false }, 'deposit');
    case 'deposit':
      return executeAction(cfg, rpc, values, 'deposit');
    case 'withdraw':
      return executeAction(cfg, rpc, values, 'withdraw');
    case 'monitor': {
      const wallet = readOnlyWallet(cfg, values, true)!;
      const world = await loadWorld(cfg, rpc, wallet);
      const programs = await inspectPrograms(rpc, [...new Set(cfg.pools.map((p) => p.program))], world.chain);
      const report = runMonitor({ chain: world.chain, policy: cfg.policy, evaluations: world.evaluations, programs, portfolio: world.portfolio! });
      if (values.json) {
        printJson({ ...report, totalValueLamports: world.portfolio!.totalValueLamports });
      } else {
        printChain(world.chain, rpc);
        out(`Total value: ${sol(world.portfolio!.totalValueLamports, 9)}`);
        if (report.alerts.length === 0) out('No alerts.');
        for (const a of report.alerts) out(`[${a.level.toUpperCase()}] ${a.message}`);
        for (const r of report.recommendations) out(`suggestion: ${r}`);
      }
      return report.exitCode;
    }
    case 'selfcheck':
      return selfcheck(cfg, rpc, values);
    default:
      throw new UsageError(`unknown command "${command}"\n\n${HELP}`);
  }
}

if (import.meta.main ?? process.argv[1] === import.meta.filename) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      if (e instanceof UsageError) err(`error: ${e.message}`);
      else if (e instanceof ExecutionError) {
        err(`error: ${e.message}`);
        for (const l of e.logs.slice(-15)) err(`  log: ${l}`);
      } else err(`error: ${(e as Error)?.message ?? String(e)}`);
      process.exit(3);
    },
  );
}
