// Policy validation, the RPC client, monitor alerts and the ledger.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePolicy, parsePools } from '../src/core/policy.ts';
import { Rpc, RpcError } from '../src/solana/rpc.ts';
import { runMonitor } from '../src/core/monitor.ts';
import { inspectPrograms } from '../src/core/pools.ts';
import { Ledger, trailingApy, type SnapshotEntry } from '../src/core/ledger.ts';
import { deriveAssociatedTokenAddress } from '../src/solana/programs.ts';
import { TOKEN_PROGRAM_ID } from '../src/solana/constants.ts';
import { encodeTokenAccount, newAddress } from './fixtures.ts';
import { defaultPolicyJson, load, policyWith, scenario } from './world.ts';

// ------------------------------------------------------------------ policy

test('shipped policy and pool allowlist parse', () => {
  const p = parsePolicy(defaultPolicyJson());
  assert.equal(p.reserveLamports, 10_000_000n);
  assert.equal(p.requireSlippageGuardedInstructions, true);
});

test('policy rejects typos, missing keys and values that would disable guardrails', () => {
  const base = defaultPolicyJson();
  assert.throws(() => parsePolicy({ ...base, reserveSOL: '0.01' }), /unknown policy key/);
  const { slippageBps: _omit, ...missing } = base;
  assert.throws(() => parsePolicy(missing), /slippageBps is required/);
  assert.throws(() => parsePolicy({ ...base, slippageBps: 5000 }), /between/);
  assert.throws(() => parsePolicy({ ...base, reserveSol: '0' }), /at least 0.005/);
  assert.throws(() => parsePolicy({ ...base, maxPriorityFeeSol: '0.5' }), /not allowed/);
  assert.throws(() => parsePolicy({ ...base, reserveSol: 0.01 }), /decimal string/);
  assert.throws(() => parsePolicy({ ...base, cluster: 'mainnet' }), /cluster/);
  assert.throws(() => parsePolicy({ ...base, requireSlippageGuardedInstructions: 'yes' }), /boolean/);
});

test('pool allowlist entries must use an allowlisted program and be unique', () => {
  const policy = policyWith();
  const entry = { symbol: 'X', name: 'x', stakePool: newAddress(), mint: newAddress(), program: 'SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy' };
  assert.equal(parsePools([entry], policy).length, 1);
  assert.throws(() => parsePools([{ ...entry, program: newAddress() }], policy), /not in policy.allowedStakePoolPrograms/);
  assert.throws(() => parsePools([entry, { ...entry }], policy), /duplicate/);
  assert.throws(() => parsePools([{ ...entry, extra: 1 }], policy), /unknown key/);
  assert.throws(() => parsePools([{ ...entry, stakePool: 'nope' }], policy), /invalid address/);
});

// ------------------------------------------------------------------ rpc

async function withServer(handler: (body: { method: string; id: number }) => { status?: number; text: string }, fn: (url: string) => Promise<void>) {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const r = handler(JSON.parse(body));
      res.statusCode = r.status ?? 200;
      res.end(r.text);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  try {
    await fn(`http://127.0.0.1:${addr.port}/secret-api-key?token=abc`);
  } finally {
    server.close();
  }
}

test('RPC client retries transient HTTP errors and keeps big integers exact', async () => {
  let calls = 0;
  await withServer(
    (b) => {
      calls++;
      if (calls < 3) return { status: 429, text: 'slow down' };
      // 2^60 lamports cannot be represented exactly as a JS number.
      return { text: `{"jsonrpc":"2.0","id":${b.id},"result":{"context":{"slot":1},"value":1152921504606846977}}` };
    },
    async (url) => {
      const rpc = new Rpc(url, { sleep: async () => {} });
      assert.equal(await rpc.getBalance(newAddress()), 1152921504606846977n);
      assert.equal(calls, 3);
      assert.equal(rpc.displayUrl, `http://${new URL(url).host}`, 'API keys in the path/query are never displayed');
    },
  );
});

test('RPC client surfaces JSON-RPC errors with code and data, and gives up after max retries', async () => {
  await withServer(
    (b) => ({ text: JSON.stringify({ jsonrpc: '2.0', id: b.id, error: { code: -32002, message: 'Transaction simulation failed', data: { err: 'x', logs: ['l'] } } }) }),
    async (url) => {
      const rpc = new Rpc(url, { sleep: async () => {} });
      await assert.rejects(rpc.sendTransaction('AA=='), (e: unknown) => e instanceof RpcError && e.code === -32002 && (e.data as { logs: string[] }).logs[0] === 'l');
    },
  );
  await withServer(
    () => ({ status: 503, text: '' }),
    async (url) => {
      const rpc = new Rpc(url, { sleep: async () => {}, maxRetries: 2 });
      await assert.rejects(rpc.getGenesisHash(), /failed after 3 attempts/);
    },
  );
});

test('RPC client refuses plain http except for localhost', () => {
  assert.throws(() => new Rpc('http://api.mainnet-beta.solana.com'), /https/);
  assert.doesNotThrow(() => new Rpc('https://api.mainnet-beta.solana.com'));
  assert.doesNotThrow(() => new Rpc('http://127.0.0.1:8899'));
});

// ------------------------------------------------------------------ monitor

test('monitor: healthy position => exit 0; exposure to a bad pool, delegate or value drop => alerts', async () => {
  const s = scenario();
  const ata = deriveAssociatedTokenAddress(s.wallet, s.jito.mint, TOKEN_PROGRAM_ID);
  s.chain.setWallet(s.wallet, 12_000_000n);
  s.chain.setAccount(ata, { lamports: 2_039_280n, owner: TOKEN_PROGRAM_ID, data: encodeTokenAccount({ mint: s.jito.mint, owner: s.wallet, amount: 790_000_000n }) });
  let w = await load(s);
  let programs = await inspectPrograms(s.rpc, [s.pools[0]!.program], w.ctx);
  let report = runMonitor({ chain: w.ctx, policy: s.policy, evaluations: w.evaluations, programs, portfolio: w.portfolio });
  assert.deepEqual(report.alerts.filter((a) => a.level !== 'info'), []);
  assert.equal(report.exitCode, 0);

  // A pending exit-fee hike on the pool we hold must page us; the same issue on a pool we
  // do not hold is only informational.
  const s2 = scenario({ jito: { nextSolWithdrawalFee: { numerator: 2n, denominator: 100n } }, blaze: { nextSolWithdrawalFee: { numerator: 2n, denominator: 100n } } });
  s2.chain.setWallet(s2.wallet, 12_000_000n);
  s2.chain.setAccount(deriveAssociatedTokenAddress(s2.wallet, s2.jito.mint, TOKEN_PROGRAM_ID), {
    lamports: 2_039_280n,
    owner: TOKEN_PROGRAM_ID,
    data: encodeTokenAccount({ mint: s2.jito.mint, owner: s2.wallet, amount: 790_000_000n }),
  });
  w = await load(s2);
  programs = await inspectPrograms(s2.rpc, [s2.pools[0]!.program], w.ctx);
  report = runMonitor({ chain: w.ctx, policy: s2.policy, evaluations: w.evaluations, programs, portfolio: w.portfolio });
  assert.equal(report.exitCode, 2);
  assert.ok(report.alerts.some((a) => a.level === 'critical' && a.message.startsWith('JitoSOL')));
  assert.ok(report.alerts.some((a) => a.level === 'info' && a.message.startsWith('bSOL')));

  // Value floor: a drained wallet is a critical alert.
  const s3 = scenario({ walletLamports: 100_000_000n });
  w = await load(s3);
  report = runMonitor({ chain: w.ctx, policy: s3.policy, evaluations: w.evaluations, programs: [], portfolio: w.portfolio });
  assert.ok(report.alerts.some((a) => a.code === 'value-floor'));
  assert.equal(report.exitCode, 2);
});

test('monitor flags a wrong cluster and suggests depositing idle SOL', async () => {
  const s = scenario();
  s.chain.genesisHash = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
  const w = await load(s);
  const report = runMonitor({ chain: w.ctx, policy: s.policy, evaluations: w.evaluations, programs: [], portfolio: w.portfolio });
  assert.ok(report.alerts.some((a) => a.code === 'wrong-cluster'));
  assert.ok(report.recommendations.some((r) => /idle/.test(r)));
});

// ------------------------------------------------------------------ ledger

test('ledger appends, survives a torn line, and computes trailing APY across epochs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'solprofits-ledger-'));
  const ledger = new Ledger(join(dir, 'sub', 'ledger.jsonl'));
  const snap = (epoch: number, tl: bigint): SnapshotEntry => ({
    type: 'snapshot',
    ts: new Date().toISOString(),
    epoch: String(epoch),
    wallet: 'W',
    solLamports: '1',
    totalValueLamports: '1',
    positions: [],
    rates: [{ symbol: 'JitoSOL', epoch: String(epoch), totalLamports: tl.toString(), poolTokenSupply: '1000000000' }],
  });
  ledger.append(snap(800, 1_250_000_000n));
  ledger.append(snap(810, 1_254_632_000n)); // +0.37056% over 10 epochs
  // Simulate a crash mid-write.
  appendFileSync(ledger.path, '{"type":"snapsh');
  const snaps = ledger.snapshots('W');
  assert.equal(snaps.length, 2);
  const t = trailingApy(snaps, 'JitoSOL', 182.5)!;
  assert.equal(t.epochs, 10);
  assert.ok(t.apy > 0.06 && t.apy < 0.075, `trailing apy ${t.apy}`);
  assert.equal(trailingApy(snaps.slice(0, 1), 'JitoSOL', 182.5), null);
});
