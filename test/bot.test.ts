// Memecoin bot: parsing, on-chain safety checks, strategy rules, swap firewall,
// swap execution and the engine (paper + live) against the mock chain and mock Jupiter.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PublicKey, SystemProgram, TransactionInstruction, ComputeBudgetProgram } from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, getAssociatedTokenAddressSync, getExtensionTypes, unpackMint } from '@solana/spl-token';
import { parseToken, type TokenInfo } from '../src/bot/feed.ts';
import { parseQuote, WSOL_MINT } from '../src/bot/jupiter.ts';
import { parseBotPolicy, type BotPolicy } from '../src/bot/policy.ts';
import { checkMintAccount, parseMintExtensions } from '../src/bot/safety.ts';
import { decideExit, positionSize, rankCandidates, scoreToken, screenToken } from '../src/bot/strategy.ts';
import { executeSwap, SwapRejected, type SwapContext } from '../src/bot/swap.ts';
import { Engine, EventLog, LiveBroker, PaperBroker } from '../src/bot/engine.ts';
import { StateStore } from '../src/bot/state.ts';
import { signerFromSecretKey, toAddress, type Address } from '../src/crypto/keys.ts';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../src/solana/constants.ts';
import { concatBytes, u16le } from '../src/util/bytes.ts';
import { deriveAssociatedTokenAddress } from '../src/solana/programs.ts';
import { deterministicKeypair, encodeMint, encodeTokenAccount, newAddress } from './fixtures.ts';
import { InProcessRpc, MockChain } from './mock-chain.ts';
import { MockFeed, MockJupiter, type MockToken } from './mock-jupiter.ts';
import { REPO_ROOT } from './world.ts';

const RENT = 2_039_280n;
const policyJson = () => JSON.parse(readFileSync(resolve(REPO_ROOT, 'config/bot-policy.json'), 'utf8')) as Record<string, unknown>;
const NOW = Date.parse('2026-11-01T00:00:00Z');

function botWorld() {
  const chain = new MockChain();
  const jup = new MockJupiter(chain);
  const walletKp = deterministicKeypair(11);
  const wallet = toAddress(walletKp.publicKey.toBase58());
  chain.setWallet(wallet, 1_000_000_000n);
  const rpc = new InProcessRpc(chain);
  const policy = parseBotPolicy(policyJson());
  // 0.0001 SOL per whole token, 6 decimals.
  const pepe = jup.addToken({ symbol: 'PEPE', decimals: 6, tokenProgram: TOKEN_PROGRAM_ID, lamportsPerToken: 100_000 });
  return { chain, jup, wallet, walletKp, rpc, policy, pepe };
}

function swapCtx(w: ReturnType<typeof botWorld>, live: boolean, halted = false): SwapContext {
  return {
    rpc: w.rpc,
    jupiter: w.jup,
    wallet: w.wallet,
    signer: live ? signerFromSecretKey(w.walletKp.secretKey) : null,
    maxPriorityFeeLamports: w.policy.maxPriorityFeeLamports,
    rentTokenAccount: RENT,
    isHalted: () => halted,
    log: () => {},
    sleep: async () => {},
  };
}

const buyReq = (w: ReturnType<typeof botWorld>, t: MockToken, lamports = 300_000_000n) => ({
  inputMint: WSOL_MINT,
  outputMint: t.mint,
  inputTokenProgram: TOKEN_PROGRAM_ID,
  outputTokenProgram: t.tokenProgram,
  amount: lamports,
  slippageBps: w.policy.buySlippageBps,
  maxPriceImpactPct: w.policy.maxPriceImpactPct,
});

// ------------------------------------------------------------------ parsing

test('token feed entries are validated and sanitized', () => {
  const w = botWorld();
  const t = parseToken(w.jup.feedEntry(w.pepe, { symbol: 'PE‮PE' }))!;
  assert.equal(t.mint, w.pepe.mint);
  assert.equal(t.symbol, 'PE?PE', 'control/bidi characters are neutralized');
  assert.equal(t.stats1h.priceChangePct, 40);
  assert.equal(t.topHoldersPct, 15);
  assert.ok(t.firstPoolAt !== null);
  assert.equal(parseToken({ ...w.jup.feedEntry(w.pepe), id: 'not-an-address' }), null);
  assert.equal(parseToken({ ...w.jup.feedEntry(w.pepe), decimals: 99 }), null);
  assert.equal(parseToken(null), null);
});

test('quotes: integer strings, impact as fraction, no platform fee, exact-in only', () => {
  const w = botWorld();
  const raw = w.jup.rawQuote({ inputMint: WSOL_MINT, outputMint: w.pepe.mint, amount: 1_000_000n, slippageBps: 100 });
  const q = parseQuote(raw);
  assert.equal(q.inAmount, 1_000_000n);
  assert.ok(q.outAmount > 0n);
  assert.ok(Math.abs(q.priceImpactPct - 0.1) < 1e-9, 'API fraction 0.001 = 0.1%');
  assert.throws(() => parseQuote({ ...raw, platformFee: { amount: '5', feeBps: 50 } }), /platform fee/);
  assert.throws(() => parseQuote({ ...raw, swapMode: 'ExactOut' }), /swapMode/);
  assert.throws(() => parseQuote({ ...raw, outAmount: '1.5' }), /integer/);
});

// ------------------------------------------------------------------ on-chain safety

function token2022Mint(exts: [number, number][], authorities: { mint?: Address | null; freeze?: Address | null } = {}): Uint8Array {
  const base = new Uint8Array(165);
  base.set(encodeMint({ mintAuthority: authorities.mint ?? null, supply: 1_000_000n, decimals: 6, freezeAuthority: authorities.freeze ?? null }));
  return concatBytes(base, Uint8Array.of(1), ...exts.flatMap(([type, len]) => [u16le(type), u16le(len), new Uint8Array(len)]));
}

test('mint checks reject active authorities and dangerous Token-2022 extensions', () => {
  const ok = checkMintAccount(newAddress(), { lamports: 1n, owner: TOKEN_PROGRAM_ID, executable: false, data: encodeMint({ mintAuthority: null, supply: 5n }) });
  assert.equal(ok.ok, true, ok.reasons.join());
  const minty = checkMintAccount(newAddress(), { lamports: 1n, owner: TOKEN_PROGRAM_ID, executable: false, data: encodeMint({ mintAuthority: newAddress(), supply: 5n }) });
  assert.match(minty.reasons.join(), /mint authority still active/);
  const frozen = checkMintAccount(newAddress(), { lamports: 1n, owner: TOKEN_PROGRAM_ID, executable: false, data: encodeMint({ mintAuthority: null, supply: 5n, freezeAuthority: newAddress() }) });
  assert.match(frozen.reasons.join(), /freeze authority/);
  assert.equal(checkMintAccount(newAddress(), null).ok, false);
  assert.match(checkMintAccount(newAddress(), { lamports: 1n, owner: newAddress(), executable: false, data: new Uint8Array(82) }).reasons.join(), /not an SPL token/);

  // Token-2022: metadata extensions are fine; fee/hook/delegate/pausable are not.
  const benign = token2022Mint([[18, 64], [19, 120]]);
  const benignCheck = checkMintAccount(newAddress(), { lamports: 1n, owner: TOKEN_2022_PROGRAM_ID, executable: false, data: benign });
  assert.equal(benignCheck.ok, true, benignCheck.reasons.join());
  assert.deepEqual(benignCheck.extensions, ['MetadataPointer', 'TokenMetadata']);
  for (const [type, name] of [[1, 'TransferFeeConfig'], [12, 'PermanentDelegate'], [14, 'TransferHook'], [6, 'DefaultAccountState'], [26, 'Pausable'], [99, 'unknown type 99']] as const) {
    const c = checkMintAccount(newAddress(), { lamports: 1n, owner: TOKEN_2022_PROGRAM_ID, executable: false, data: token2022Mint([[18, 64], [type, 32]]) });
    assert.equal(c.ok, false, name);
    assert.match(c.reasons.join(), new RegExp(name));
  }
});

test('Token-2022 extension parsing matches @solana/spl-token', () => {
  const types: [number, number][] = [[3, 32], [18, 64], [19, 77], [1, 108], [14, 64], [12, 32]];
  const data = token2022Mint(types);
  assert.deepEqual(parseMintExtensions(data), getExtensionTypes(Buffer.from(data.slice(166))));
  const t22 = new PublicKey(TOKEN_2022_PROGRAM_ID);
  assert.doesNotThrow(() => unpackMint(new PublicKey(newAddress()), { data: Buffer.from(data), owner: t22, lamports: 1, executable: false }, t22));
});

// ------------------------------------------------------------------ strategy

test('screening explains every rejection; ranking prefers organic momentum', () => {
  const w = botWorld();
  const p = w.policy;
  const good = parseToken(w.jup.feedEntry(w.pepe, {}, NOW))!;
  assert.deepEqual(screenToken(good, p, NOW), []);
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ liquidity: 1_000 }, /liquidity/],
    [{ holderCount: 50 }, /holders/],
    [{ organicScore: 5 }, /organic score/],
    [{ audit: { topHoldersPercentage: 70, mintAuthorityDisabled: true, freezeAuthorityDisabled: true } }, /top holders/],
    [{ audit: { topHoldersPercentage: 10, mintAuthorityDisabled: false, freezeAuthorityDisabled: true } }, /mint authority/],
    [{ firstPool: { createdAt: new Date(NOW - 3_600_000).toISOString() } }, /fresh launches/],
    [{ stats1h: { priceChange: 400, buyVolume: 1e6, sellVolume: 1e5 } }, /blow-off/],
    [{ stats1h: { priceChange: 2, buyVolume: 1e6, sellVolume: 1e5 } }, /1h change/],
    [{ stats5m: { priceChange: -4, buyVolume: 1e4, sellVolume: 1e4 } }, /momentum fading/],
    [{ stats1h: { priceChange: 40, buyVolume: 100_000, sellVolume: 150_000 } }, /buy\/sell ratio/],
    [{ mcap: 10_000_000_000 }, /market cap/],
    [{ liquidity: null }, /no liquidity data/],
  ];
  for (const [o, re] of cases) assert.match(screenToken(parseToken(w.jup.feedEntry(w.pepe, o, NOW))!, p, NOW).join(' | '), re);

  const strong = parseToken(w.jup.feedEntry(w.pepe, { stats1h: { priceChange: 90, buyVolume: 300_000, sellVolume: 100_000 } }, NOW))!;
  const weak = parseToken(w.jup.feedEntry({ ...w.pepe, mint: newAddress() }, { stats1h: { priceChange: 15, buyVolume: 120_000, sellVolume: 100_000 } }, NOW))!;
  assert.ok(scoreToken(strong) > scoreToken(weak));
  const { passed } = rankCandidates([weak, strong], p, NOW, new Set());
  assert.deepEqual(passed.map((t) => t.mint), [strong.mint, weak.mint]);
  assert.equal(rankCandidates([strong], p, NOW, new Set([strong.mint])).passed.length, 0, 'excluded mints are skipped');
});

test('position sizing respects the fee reserve, the equity floor and the position cap', () => {
  const p = parseBotPolicy(policyJson());
  const s = positionSize({ equityLamports: 1_000_000_000n, solLamports: 1_000_000_000n, openPositions: 0, policy: p, rentLamports: RENT });
  assert.equal(s.lamports, 300_000_000n);
  const tight = positionSize({ equityLamports: 1_000_000_000n, solLamports: 100_000_000n, openPositions: 2, policy: p, rentLamports: RENT });
  assert.equal(tight.lamports, 100_000_000n - 20_000_000n - RENT - 500_000n - 5_000n, 'never dips into the reserve');
  assert.equal(positionSize({ equityLamports: 1_000_000_000n, solLamports: 1_000_000_000n, openPositions: 3, policy: p, rentLamports: RENT }).lamports, null);
  assert.match(String((positionSize({ equityLamports: 150_000_000n, solLamports: 150_000_000n, openPositions: 0, policy: p, rentLamports: RENT }) as { reason: string }).reason), /floor/);
  assert.equal(positionSize({ equityLamports: 1_000_000_000n, solLamports: 60_000_000n, openPositions: 0, policy: p, rentLamports: RENT }).lamports, null, 'below minimum size');
});

test('exit rules: stop-loss, take-profit half at +100%, trailing stop, time stop', () => {
  const p = parseBotPolicy(policyJson());
  const base = { openedAt: NOW, costLamports: 1_000n, realizedLamports: 0n, peakValueLamports: 1_000n, takeProfitDone: false };
  assert.deepEqual(decideExit(base, 900n, NOW, p), { action: 'hold' });
  assert.equal((decideExit(base, 700n, NOW, p) as { reason: string }).reason, 'stop-loss');
  const tp = decideExit(base, 2_000n, NOW, p) as { reason: string; fraction: number };
  assert.equal(tp.reason, 'take-profit');
  assert.equal(tp.fraction, 0.5);
  const after = { ...base, takeProfitDone: true, peakValueLamports: 1_500n };
  assert.deepEqual(decideExit(after, 1_100n, NOW, p), { action: 'hold' });
  assert.equal((decideExit(after, 1_050n, NOW, p) as { reason: string }).reason, 'trailing-stop');
  assert.equal((decideExit(base, 1_000n, NOW + 49 * 3_600_000, p) as { reason: string }).reason, 'time-stop');
});

test('bot policy rejects typos and unsafe values', () => {
  assert.throws(() => parseBotPolicy({ ...policyJson(), stopLoss: 30 }), /unknown bot-policy key/);
  assert.throws(() => parseBotPolicy({ ...policyJson(), feeReserveSol: '0.001' }), /at least 0.01/);
  assert.throws(() => parseBotPolicy({ ...policyJson(), maxPriorityFeeSol: '0.1' }), /not allowed/);
  assert.throws(() => parseBotPolicy({ ...policyJson(), filters: { ...(policyJson().filters as object), minLiq: 1 } }), /unknown bot-policy.filters key/);
});

// ------------------------------------------------------------------ swap firewall + execution

test('a well-formed v0 Jupiter buy and sell simulate, pass the firewall and execute', async () => {
  const w = botWorld();
  const sim = await executeSwap(swapCtx(w, false), buyReq(w, w.pepe));
  assert.equal(sim.status, 'simulated');
  assert.ok(sim.tokenDelta > 0n);
  assert.match(sim.actions.join('\n'), /wrap 300000000 lamports/);
  assert.match(sim.actions.join('\n'), /program-enforced/);
  assert.equal(w.chain.sentSignatures.length, 0, 'simulation never sends');

  const live = await executeSwap(swapCtx(w, true), buyReq(w, w.pepe));
  assert.equal(live.status, 'confirmed');
  const ata = deriveAssociatedTokenAddress(w.wallet, w.pepe.mint, TOKEN_PROGRAM_ID);
  assert.equal(w.chain.tokenBalance(ata), live.tokenDelta);
  assert.ok(-live.solDelta > 300_000_000n && -live.solDelta < 300_000_000n + RENT + 300_000n, `spent ${-live.solDelta}`);

  const sell = await executeSwap(swapCtx(w, true), {
    inputMint: w.pepe.mint, outputMint: WSOL_MINT, inputTokenProgram: TOKEN_PROGRAM_ID, outputTokenProgram: TOKEN_PROGRAM_ID,
    amount: live.tokenDelta, slippageBps: 300, maxPriceImpactPct: 100,
  });
  assert.equal(sell.status, 'confirmed');
  assert.equal(w.chain.tokenBalance(ata), 0n);
  assert.ok(sell.solDelta > 298_000_000n, `round trip at a constant price returned ${sell.solDelta}`);
});

test('the swap firewall rejects tampered aggregator transactions before anything is signed', async (t) => {
  const attacker = new PublicKey(newAddress());
  const cases: [string, (ixs: TransactionInstruction[], u: PublicKey, w: ReturnType<typeof botWorld>) => TransactionInstruction[], RegExp][] = [
    ['an extra SOL transfer to a third party', (ixs, u) => [...ixs, SystemProgram.transfer({ fromPubkey: u, toPubkey: attacker, lamports: 1_000 })], /only wrapping/],
    ['route output redirected to an attacker account', (ixs, _u, w) => ixs.map((ix) => {
      if (ix.programId.toBase58() !== 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4') return ix;
      const keys = ix.keys.map((k, i) => (i === 6 ? { ...k, pubkey: getAssociatedTokenAddressSync(new PublicKey(w.pepe.mint), attacker) } : k));
      return new TransactionInstruction({ programId: ix.programId, keys, data: ix.data });
    }), /route destination/],
    ['a platform fee snuck into the route', (ixs) => ixs.map((ix) => {
      if (ix.programId.toBase58() !== 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4') return ix;
      const data = Buffer.from(ix.data);
      data[data.length - 1] = 50;
      return new TransactionInstruction({ programId: ix.programId, keys: ix.keys, data });
    }), /platform fee/],
    ['route spends more than quoted', (ixs) => ixs.map((ix) => {
      if (ix.programId.toBase58() !== 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4') return ix;
      const data = Buffer.from(ix.data);
      data.writeBigUInt64LE(999_000_000n, data.length - 19);
      return new TransactionInstruction({ programId: ix.programId, keys: ix.keys, data });
    }), /route spends/],
    ['a second signer', (ixs) => [...ixs, new TransactionInstruction({ programId: new PublicKey(newAddress()), keys: [{ pubkey: attacker, isSigner: true, isWritable: false }], data: Buffer.alloc(0) })], /signers must be exactly/],
    ['an unknown program', (ixs) => [...ixs, new TransactionInstruction({ programId: new PublicKey(newAddress()), keys: [], data: Buffer.from([1]) })], /not allowlisted/],
    ['WSOL unwrapped to an attacker', (ixs, u) => ixs.map((ix) => (ix.programId.toBase58() === TOKEN_PROGRAM_ID && ix.data[0] === 9 ? createCloseAccountInstruction(getAssociatedTokenAddressSync(new PublicKey(WSOL_MINT), u), attacker, u) : ix)), /token instruction 9/],
    ['an excessive priority fee', (ixs) => ixs.map((ix) => (ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === 3 ? ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000_000_000n }) : ix)), /priority fee/],
    ['a token account created for someone else', (ixs, u, w) => [createAssociatedTokenAccountIdempotentInstruction(u, getAssociatedTokenAddressSync(new PublicKey(w.pepe.mint), attacker), attacker, new PublicKey(w.pepe.mint)), ...ixs], /not for the wallet's own account/],
    ['two routes', (ixs) => [...ixs, ...ixs.filter((ix) => ix.programId.toBase58() === 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4')], /exactly one Jupiter route/],
  ];
  for (const [name, tamper, expected] of cases) {
    await t.test(name, async () => {
      const w = botWorld();
      w.jup.tamper = (ixs, u) => tamper(ixs, u, w);
      await assert.rejects(executeSwap(swapCtx(w, true), buyReq(w, w.pepe)), (e: unknown) => e instanceof SwapRejected && expected.test(e.message));
      assert.equal(w.chain.sentSignatures.length, 0, 'nothing was sent');
    });
  }
});

test('price moving against us between quote and execution is stopped by the on-chain minimum', async () => {
  const w = botWorld();
  w.jup.tamper = (ixs) => {
    w.jup.setPrice(w.pepe.mint, 110_000); // 10% more expensive by the time the transaction runs
    return ixs;
  };
  await assert.rejects(executeSwap(swapCtx(w, true), buyReq(w, w.pepe)), /swap simulation failed.*6001/s);
  assert.equal(w.chain.sentSignatures.length, 0);
});

test('kill switch blocks signing even after a clean simulation', async () => {
  const w = botWorld();
  await assert.rejects(executeSwap(swapCtx(w, true, true), buyReq(w, w.pepe)), /kill switch/);
  assert.equal(w.chain.sentSignatures.length, 0);
});

// ------------------------------------------------------------------ engine

function engineFor(w: ReturnType<typeof botWorld>, mode: 'paper' | 'live', clock: { now: number }, opts: { halted?: () => boolean; policy?: BotPolicy } = {}) {
  const dir = mkdtempSync(join(tmpdir(), `solprofits-bot-${mode}-`));
  const store = new StateStore(join(dir, 'state.json'));
  const policy = opts.policy ?? w.policy;
  const broker = mode === 'paper' ? new PaperBroker(w.jup, policy, RENT) : new LiveBroker(swapCtx(w, true), policy);
  const engine = new Engine({
    policy,
    feed: new MockFeed(w.jup),
    market: w.jup,
    rpc: w.rpc,
    broker,
    store,
    events: new EventLog(join(dir, 'events.jsonl')),
    wallet: w.wallet,
    rentTokenAccount: RENT,
    isHalted: opts.halted ?? (() => false),
    log: () => {},
    now: () => clock.now,
  });
  return { engine, store, dir };
}

test('paper engine: skips a frozen token, buys the next candidate, takes half at 2x, trails out the rest', async () => {
  const w = botWorld();
  const frz = w.jup.addToken({ symbol: 'FRZ', decimals: 6, tokenProgram: TOKEN_PROGRAM_ID, lamportsPerToken: 100_000, freezeAuthority: newAddress() });
  const junk = w.jup.addToken({ symbol: 'JUNK', decimals: 6, tokenProgram: TOKEN_PROGRAM_ID, lamportsPerToken: 100_000 });
  w.jup.feed = [
    // FRZ ranks highest but its mint has a freeze authority on-chain (the feed claims otherwise).
    w.jup.feedEntry(frz, { stats1h: { priceChange: 95, buyVolume: 300_000, sellVolume: 100_000 } }, NOW),
    w.jup.feedEntry(w.pepe, {}, NOW),
    w.jup.feedEntry(junk, { liquidity: 2_000 }, NOW),
  ];
  const clock = { now: NOW };
  const { engine, store } = engineFor(w, 'paper', clock);
  await engine.loadOrInit(1_000_000_000n);

  const r1 = await engine.tick({ forceScan: true });
  let s = store.load();
  assert.match(r1.actions.join(), /buy: .*PEPE/);
  assert.equal(s.positions.length, 1);
  assert.match(s.rejects[frz.mint]!.reason, /freeze authority/);
  assert.equal(w.chain.sentSignatures.length, 0, 'paper mode never sends');

  clock.now += 60_000;
  w.jup.setPrice(w.pepe.mint, 220_000); // 2.2x
  const r2 = await engine.tick();
  s = store.load();
  assert.match(r2.actions.join(), /take-profit/);
  assert.equal(s.positions[0]!.takeProfitDone, true);

  clock.now += 60_000;
  w.jup.setPrice(w.pepe.mint, 300_000); // peak 3x
  await engine.tick();
  clock.now += 60_000;
  w.jup.setPrice(w.pepe.mint, 200_000); // -33% from the peak
  const r4 = await engine.tick();
  s = store.load();
  assert.match(r4.actions.join(), /trailing-stop/);
  assert.equal(s.positions.length, 0);
  assert.equal(s.closed.length, 1);
  const trade = s.closed[0]!;
  assert.ok(BigInt(trade.proceedsLamports) > BigInt(trade.costLamports) * 2n, 'half at ~2.2x plus half at ~2x');
  assert.ok(s.cooldowns[w.pepe.mint]! > clock.now, 'no immediate re-entry');
  // 0.3 SOL position closed at ~2.1x: 1 SOL -> ~1.33 SOL.
  assert.ok(BigInt(s.paperSolLamports!) > 1_300_000_000n, `paper SOL ${s.paperSolLamports}`);
});

test('paper engine: stop-loss, time stop, equity floor, position cap and kill switch', async (t) => {
  await t.test('stop-loss at -30%', async () => {
    const w = botWorld();
    w.jup.feed = [w.jup.feedEntry(w.pepe, {}, NOW)];
    const clock = { now: NOW };
    const { engine, store } = engineFor(w, 'paper', clock);
    await engine.loadOrInit(1_000_000_000n);
    await engine.tick({ forceScan: true });
    w.jup.setPrice(w.pepe.mint, 65_000);
    clock.now += 30_000;
    const r = await engine.tick();
    assert.match(r.actions.join(), /stop-loss/);
    assert.equal(store.load().positions.length, 0);
  });
  await t.test('time stop after maxHoldHours', async () => {
    const w = botWorld();
    w.jup.feed = [w.jup.feedEntry(w.pepe, {}, NOW)];
    const clock = { now: NOW };
    const { engine } = engineFor(w, 'paper', clock);
    await engine.loadOrInit(1_000_000_000n);
    await engine.tick({ forceScan: true });
    clock.now += 49 * 3_600_000;
    assert.match((await engine.tick()).actions.join(), /time-stop/);
  });
  await t.test('no buys below the equity floor', async () => {
    const w = botWorld();
    w.jup.feed = [w.jup.feedEntry(w.pepe, {}, NOW)];
    const { engine, store } = engineFor(w, 'paper', { now: NOW });
    await engine.loadOrInit(150_000_000n);
    const r = await engine.tick({ forceScan: true });
    assert.match(r.notes.join(), /below the floor/);
    assert.equal(store.load().positions.length, 0);
  });
  await t.test('at most maxOpenPositions positions, one entry per scan', async () => {
    const w = botWorld();
    const extra = [1, 2, 3].map((i) => w.jup.addToken({ symbol: `T${i}`, decimals: 6, tokenProgram: TOKEN_PROGRAM_ID, lamportsPerToken: 100_000 }));
    w.jup.feed = [w.pepe, ...extra].map((tk) => w.jup.feedEntry(tk, {}, NOW));
    const clock = { now: NOW };
    const { engine, store } = engineFor(w, 'paper', clock);
    await engine.loadOrInit(1_000_000_000n);
    for (let i = 0; i < 5; i++) {
      await engine.tick({ forceScan: true });
      clock.now += 1_000;
    }
    assert.equal(store.load().positions.length, 3);
  });
  await t.test('kill switch: nothing happens', async () => {
    const w = botWorld();
    w.jup.feed = [w.jup.feedEntry(w.pepe, {}, NOW)];
    const { engine, store } = engineFor(w, 'paper', { now: NOW }, { halted: () => true });
    await engine.loadOrInit(1_000_000_000n);
    const r = await engine.tick({ forceScan: true });
    assert.match(r.notes.join(), /kill switch/);
    assert.equal(store.load().positions.length, 0);
  });
});

test('live engine: real (mock-chain) buy, stop-loss exit, token account closed, history recorded', async () => {
  const w = botWorld();
  w.jup.feed = [w.jup.feedEntry(w.pepe, {}, NOW)];
  const clock = { now: NOW };
  const { engine, store } = engineFor(w, 'live', clock);
  await engine.loadOrInit(null);
  const r1 = await engine.tick({ forceScan: true });
  assert.match(r1.actions.join(), /buy: .*PEPE/);
  const ata = deriveAssociatedTokenAddress(w.wallet, w.pepe.mint, TOKEN_PROGRAM_ID);
  const bought = w.chain.tokenBalance(ata)!;
  assert.ok(bought > 0n);
  let s = store.load();
  assert.equal(s.positions[0]!.tokens, bought.toString());
  assert.equal(s.pendingBuy, null, 'write-ahead marker cleared after a confirmed buy');

  w.jup.setPrice(w.pepe.mint, 60_000);
  clock.now += 30_000;
  const r2 = await engine.tick();
  assert.match(r2.actions.join(), /stop-loss/);
  assert.equal(w.chain.accounts.has(ata), false, 'emptied token account closed, rent refunded');
  s = store.load();
  assert.equal(s.positions.length, 0);
  const lost = 1_000_000_000n - w.chain.accounts.get(w.wallet)!.lamports;
  assert.ok(lost > 115_000_000n && lost < 130_000_000n, `a 40% drop on a 0.3 SOL position should cost ~0.12 SOL, cost ${lost}`);
});

test('live engine reconciliation adopts a buy that landed without confirmation and ignores airdrops', async () => {
  const w = botWorld();
  w.jup.feed = [];
  const clock = { now: NOW };
  const { engine, store } = engineFor(w, 'live', clock);
  await engine.loadOrInit(null);
  const s = store.load();
  s.pendingBuy = { mint: w.pepe.mint, symbol: 'PEPE', decimals: 6, tokenProgram: TOKEN_PROGRAM_ID, lamports: '300000000', at: NOW, signature: 'sig' };
  store.save(s);
  const ata = deriveAssociatedTokenAddress(w.wallet, w.pepe.mint, TOKEN_PROGRAM_ID);
  w.chain.setAccount(ata, { lamports: RENT, owner: TOKEN_PROGRAM_ID, data: encodeTokenAccount({ mint: w.pepe.mint, owner: w.wallet, amount: 2_990_000_000n }) });
  const spam = newAddress();
  w.chain.setAccount(deriveAssociatedTokenAddress(w.wallet, spam, TOKEN_PROGRAM_ID), { lamports: RENT, owner: TOKEN_PROGRAM_ID, data: encodeTokenAccount({ mint: spam, owner: w.wallet, amount: 1_000n }) });
  const r = await engine.tick();
  assert.match(r.notes.join(), /adopted PEPE/);
  assert.match(r.notes.join(), /untracked token \S+ in wallet \(ignored/);
  const after = store.load();
  assert.equal(after.positions.length, 1);
  assert.equal(after.pendingBuy, null);
  assert.ok(!after.positions.some((p) => p.mint === spam));
});
