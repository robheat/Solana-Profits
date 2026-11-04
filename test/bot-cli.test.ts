// End-to-end: `solprofits bot …` as a child process against HTTP mocks of the RPC and Jupiter.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { toAddress } from '../src/crypto/keys.ts';
import { TOKEN_PROGRAM_ID } from '../src/solana/constants.ts';
import { deriveAssociatedTokenAddress } from '../src/solana/programs.ts';
import { encodeBase58 } from '../src/util/base58.ts';
import { USDC_MINT } from '../src/bot/cli.ts';
import { deterministicKeypair } from './fixtures.ts';
import { MockChain, serveMockChain } from './mock-chain.ts';
import { MockJupiter, serveMockJupiter } from './mock-jupiter.ts';
import { REPO_ROOT } from './world.ts';

function run(args: string[], env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [resolve(REPO_ROOT, 'src/cli.ts'), 'bot', ...args], {
      cwd: REPO_ROOT,
      env: { PATH: process.env.PATH ?? '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
}

test('bot CLI end to end: scan, selfcheck, paper, refusals, live run, status, liquidate', async (t) => {
  const chain = new MockChain();
  const jup = new MockJupiter(chain);
  const kp = deterministicKeypair(12);
  const wallet = toAddress(kp.publicKey.toBase58());
  chain.setWallet(wallet, 1_000_000_000n);
  const pepe = jup.addToken({ symbol: 'PEPE', decimals: 6, tokenProgram: TOKEN_PROGRAM_ID, lamportsPerToken: 100_000 });
  jup.addToken({ mint: USDC_MINT, symbol: 'USDC', decimals: 6, tokenProgram: TOKEN_PROGRAM_ID, lamportsPerToken: 6_000_000 });
  jup.feed = [jup.feedEntry(pepe)];
  const rpc = await serveMockChain(chain);
  const api = await serveMockJupiter(jup);
  const env = { SOLANA_RPC_URL: rpc.url, JUPITER_API_URL: api.url, SOLPROFITS_DATA_DIR: mkdtempSync(join(tmpdir(), 'solprofits-botcli-')) };
  const key = encodeBase58(kp.secretKey);
  const ata = deriveAssociatedTokenAddress(wallet, pepe.mint, TOKEN_PROGRAM_ID);

  try {
    await t.test('scan lists candidates with on-chain checks and quotes, read-only', async () => {
      const r = await run(['scan'], env);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /1 trending tokens screened .*: 1 pass the filters/);
      assert.match(r.stdout, /PASS PEPE .*impact 0\.10%, round trip/);
    });

    await t.test('selfcheck validates the RPC, the APIs and a real swap through the firewall', async () => {
      const r = await run(['selfcheck', '--address', wallet], env);
      assert.equal(r.code, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /✓ real Jupiter swap transaction passes the swap firewall and simulation/);
      assert.match(r.stdout, /All checks passed/);
      assert.equal(chain.sentSignatures.length, 0);
    });

    await t.test('paper trading needs no key and signs nothing', async () => {
      const r = await run(['paper', '--once', '--start-sol', '1', '--address', wallet], env);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /paper \| .*buy: .*PEPE/);
      const st = await run(['status', '--paper'], env);
      assert.match(st.stdout, /PAPER bot/);
      assert.match(st.stdout, /open {2}PEPE/);
      assert.equal(chain.sentSignatures.length, 0);
    });

    await t.test('live trading refuses without --execute, without confirmation, or with the kill switch', async () => {
      const a = await run(['run', '--once'], { ...env, SOLANA_KEYPAIR: key });
      assert.equal(a.code, 3);
      assert.match(a.stderr, /needs --execute/);
      const b = await run(['run', '--execute', '--once'], { ...env, SOLANA_KEYPAIR: key });
      assert.equal(b.code, 3);
      assert.match(b.stderr, /refusing without confirmation/);
      const c = await run(['run', '--execute', '--yes', '--once'], { ...env, SOLANA_KEYPAIR: key, SOLPROFITS_HALT: '1' });
      assert.equal(c.code, 3);
      assert.match(c.stderr, /kill switch/);
      assert.equal(chain.sentSignatures.length, 0);
    });

    await t.test('live run: pre-flight, then a real buy through the firewall', async () => {
      const r = await run(['run', '--execute', '--yes', '--once'], { ...env, SOLANA_KEYPAIR: key });
      assert.equal(r.code, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /Pre-flight/);
      assert.match(r.stdout, /live \| .*buy: .*PEPE/);
      assert.ok(!r.stdout.includes(key) && !r.stderr.includes(key), 'key never printed');
      assert.ok((chain.tokenBalance(ata) ?? 0n) > 0n);
      const st = await run(['status'], env);
      assert.match(st.stdout, /LIVE bot/);
      assert.match(st.stdout, /open {2}PEPE/);
    });

    await t.test('liquidate sells everything and closes the token account', async () => {
      const r = await run(['liquidate', '--execute', '--yes'], { ...env, SOLANA_KEYPAIR: key });
      assert.equal(r.code, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /liquidated PEPE/);
      assert.equal(chain.accounts.has(ata), false);
      const lamports = chain.accounts.get(wallet)!.lamports;
      assert.ok(lamports > 990_000_000n, `round trip at a constant price kept ${lamports}`);
    });
  } finally {
    rpc.server.close();
    api.server.close();
  }
});
