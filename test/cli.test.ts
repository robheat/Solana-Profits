// End-to-end: the real CLI (child process) against the mock chain over HTTP JSON-RPC.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { encodeBase58 } from '../src/util/base58.ts';
import { deriveAssociatedTokenAddress } from '../src/solana/programs.ts';
import { TOKEN_PROGRAM_ID } from '../src/solana/constants.ts';
import { deterministicKeypair, poolConfigOf } from './fixtures.ts';
import { serveMockChain } from './mock-chain.ts';
import { REPO_ROOT, scenario } from './world.ts';

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(args: string[], env: Record<string, string>): Promise<Run> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [resolve(REPO_ROOT, 'src/cli.ts'), ...args], {
      cwd: REPO_ROOT,
      env: { PATH: process.env.PATH ?? '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

test('CLI end to end: read-only commands, refusals, deposit, monitor, withdraw', async (t) => {
  const s = scenario();
  const { url, server } = await serveMockChain(s.chain);
  const dir = mkdtempSync(join(tmpdir(), 'solprofits-cli-'));
  const poolsPath = join(dir, 'pools.json');
  writeFileSync(poolsPath, JSON.stringify([poolConfigOf(s.jito, 'JitoSOL'), poolConfigOf(s.blaze, 'bSOL')]));
  const ledgerPath = join(dir, 'ledger.jsonl');
  const base = { SOLANA_RPC_URL: url, SOLPROFITS_POOLS: poolsPath, SOLPROFITS_LEDGER: ledgerPath };
  const key = encodeBase58(s.walletKp.secretKey);
  const ata = deriveAssociatedTokenAddress(s.wallet, s.jito.mint, TOKEN_PROGRAM_ID);

  try {
    await t.test('status works with only a public address and records a snapshot', async () => {
      const r = await run(['status', '--address', s.wallet], base);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /cluster verified/);
      assert.match(r.stdout, /TOTAL VALUE\s+1 SOL/);
      assert.match(r.stdout, /JitoSOL\s+ok/);
      assert.match(readFileSync(ledgerPath, 'utf8'), /"type":"snapshot"/);
    });

    await t.test('pools --json lists both pools as verified', async () => {
      const r = await run(['pools', '--json'], base);
      assert.equal(r.code, 0, r.stderr);
      const pools = JSON.parse(r.stdout) as { config: { symbol: string }; depositable: boolean }[];
      assert.deepEqual(pools.map((p) => [p.config.symbol, p.depositable]), [['JitoSOL', true], ['bSOL', true]]);
    });

    await t.test('plan simulates the deposit without any key', async () => {
      const r = await run(['plan', '--address', s.wallet], base);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /Deposit plan → JitoSOL/);
      assert.match(r.stdout, /deposit\s+0\.98785572 SOL/);
      assert.match(r.stdout, /✓ firewall: create the wallet.s JitoSOL token account; deposit 987855720 lamports into JitoSOL \(program-enforced minimum/);
      assert.match(r.stdout, /Dry run only: nothing was signed/);
    });

    await t.test('selfcheck passes against a consistent chain', async () => {
      const r = await run(['selfcheck', '--address', s.wallet], base);
      assert.equal(r.code, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /All checks passed/);
    });

    await t.test('refuses to sign without confirmation when not interactive', async () => {
      const r = await run(['deposit', '--execute'], { ...base, SOLANA_KEYPAIR: key });
      assert.equal(r.code, 3);
      assert.match(r.stderr, /refusing to sign without confirmation/);
      assert.equal(s.chain.sentSignatures.length, 0);
    });

    await t.test('kill switch refuses before loading the key', async () => {
      const r = await run(['deposit', '--execute', '--yes'], { ...base, SOLANA_KEYPAIR: key, SOLPROFITS_HALT: '1' });
      assert.equal(r.code, 3);
      assert.match(r.stderr, /kill switch/);
      assert.equal(s.chain.sentSignatures.length, 0);
    });

    await t.test('refuses a key that does not match WALLET_ADDRESS', async () => {
      const r = await run(['deposit', '--execute', '--yes'], { ...base, SOLANA_KEYPAIR: encodeBase58(deterministicKeypair(42).secretKey), WALLET_ADDRESS: s.wallet });
      assert.equal(r.code, 3);
      assert.match(r.stderr, /does not match/);
    });

    await t.test('refuses to sign against the wrong cluster', async () => {
      s.chain.genesisHash = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
      const r = await run(['deposit', '--execute', '--yes'], { ...base, SOLANA_KEYPAIR: key });
      s.chain.genesisHash = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
      assert.equal(r.code, 3);
      assert.match(r.stderr, /refusing to sign/);
      assert.equal(s.chain.sentSignatures.length, 0);
    });

    await t.test('deposit --execute --yes stakes the idle SOL and verifies the result', async () => {
      const r = await run(['deposit', '--execute', '--yes'], { ...base, SOLANA_KEYPAIR: key });
      assert.equal(r.code, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /✓ confirmed in slot/);
      assert.ok(!r.stdout.includes(key) && !r.stderr.includes(key), 'secret key must never be printed');
      assert.equal(s.chain.sentSignatures.length, 1);
      assert.ok((s.chain.tokenBalance(ata) ?? 0n) > 780_000_000n);
      const walletLamports = s.chain.accounts.get(s.wallet)!.lamports;
      assert.ok(walletLamports >= s.policy.reserveLamports, `reserve kept: ${walletLamports}`);
      const ledger = readFileSync(ledgerPath, 'utf8');
      assert.match(ledger, /"action":"deposit","status":"confirmed"/);
    });

    await t.test('running deposit again is a no-op (idempotent)', async () => {
      const r = await run(['deposit', '--execute', '--yes'], { ...base, SOLANA_KEYPAIR: key });
      assert.equal(r.code, 0);
      assert.match(r.stdout, /Nothing to do/);
      assert.equal(s.chain.sentSignatures.length, 1);
    });

    await t.test('monitor is healthy after the deposit', async () => {
      const r = await run(['monitor', '--address', s.wallet, '--json'], base);
      const report = JSON.parse(r.stdout) as { exitCode: number; alerts: { level: string }[] };
      assert.equal(r.code, 0, JSON.stringify(report.alerts));
      assert.equal(report.exitCode, 0);
    });

    await t.test('monitor pages (exit 2) when the held pool schedules an exit-fee hike', async () => {
      const { encodeStakePool } = await import('./fixtures.ts');
      const { decodeStakePool } = await import('../src/solana/accounts.ts');
      const live = decodeStakePool(s.chain.accounts.get(s.jito.stakePool)!.data);
      s.chain.accounts.get(s.jito.stakePool)!.data = encodeStakePool({
        ...s.jito,
        totalLamports: live.totalLamports,
        poolTokenSupply: live.poolTokenSupply,
        nextSolWithdrawalFee: { numerator: 3n, denominator: 100n },
      });
      const r = await run(['monitor', '--address', s.wallet], base);
      assert.equal(r.code, 2, r.stdout);
      assert.match(r.stdout, /\[CRITICAL\] JitoSOL: SOL withdrawal fee rising/);
      s.chain.accounts.get(s.jito.stakePool)!.data = encodeStakePool({ ...s.jito, totalLamports: live.totalLamports, poolTokenSupply: live.poolTokenSupply });
    });

    await t.test('withdraw --execute --yes exits fully and closes the token account', async () => {
      const r = await run(['withdraw', '--execute', '--yes'], { ...base, SOLANA_KEYPAIR: key });
      assert.equal(r.code, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /Withdraw plan ← JitoSOL/);
      assert.equal(s.chain.accounts.has(ata), false);
      const lamports = s.chain.accounts.get(s.wallet)!.lamports;
      assert.ok(lamports > 998_000_000n && lamports < 1_000_000_000n, `wallet after round trip: ${lamports}`);
    });
  } finally {
    server.close();
  }
});
