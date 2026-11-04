// Base58, byte helpers, amounts, keys and PDAs — cross-checked against bs58 and @solana/web3.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bs58 from 'bs58';
import { Keypair, PublicKey } from '@solana/web3.js';
import { decodeBase58, encodeBase58 } from '../src/util/base58.ts';
import { decodeShortVecLength, encodeShortVecLength, u64le, readU64le } from '../src/util/bytes.ts';
import { formatSol, parseSol, parseUnits, bps } from '../src/util/amount.ts';
import {
  addressToBytes,
  createProgramAddress,
  findProgramAddress,
  isOnCurve,
  loadSignerFromEnv,
  parseSecretKey,
  signerFromSecretKey,
  toAddress,
} from '../src/crypto/keys.ts';
import { ed25519 } from '@noble/curves/ed25519.js';

test('base58 matches bs58 on random inputs, including leading zeros', () => {
  for (let i = 0; i < 500; i++) {
    const len = i % 70;
    const bytes = new Uint8Array(randomBytes(len));
    if (i % 5 === 0 && len > 2) bytes[0] = 0;
    if (i % 7 === 0 && len > 3) {
      bytes[0] = 0;
      bytes[1] = 0;
    }
    const ours = encodeBase58(bytes);
    assert.equal(ours, bs58.encode(Buffer.from(bytes)));
    assert.deepEqual(decodeBase58(ours), bytes);
  }
});

test('base58 known vectors and invalid input', () => {
  assert.equal(encodeBase58(new Uint8Array(32)), '11111111111111111111111111111111');
  assert.equal(encodeBase58(Buffer.from('Hello World!')), '2NEpo7TZRRrLZSi2U');
  assert.throws(() => decodeBase58('0OIl'), /invalid character/);
  assert.throws(() => decodeBase58('abc def'), /invalid character/);
});

test('shortvec (compact-u16) encoding round-trips and matches spec examples', () => {
  const cases: [number, number[]][] = [
    [0, [0x00]],
    [0x7f, [0x7f]],
    [0x80, [0x80, 0x01]],
    [0xff, [0xff, 0x01]],
    [0x100, [0x80, 0x02]],
    [0x3fff, [0xff, 0x7f]],
    [0x4000, [0x80, 0x80, 0x01]],
    [0xffff, [0xff, 0xff, 0x03]],
  ];
  for (const [n, bytes] of cases) {
    assert.deepEqual([...encodeShortVecLength(n)], bytes);
    assert.deepEqual(decodeShortVecLength(Uint8Array.from(bytes), 0), [n, bytes.length]);
  }
  assert.throws(() => encodeShortVecLength(0x10000));
});

test('u64 encoding is little-endian and range-checked', () => {
  assert.deepEqual([...u64le(1n)], [1, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(readU64le(u64le(2n ** 64n - 1n), 0), 2n ** 64n - 1n);
  assert.throws(() => u64le(-1n));
  assert.throws(() => u64le(2n ** 64n));
});

test('SOL amounts parse exactly, never via floating point', () => {
  assert.equal(parseSol('1'), 1_000_000_000n);
  assert.equal(parseSol('0.000000001'), 1n);
  assert.equal(parseSol('0.1'), 100_000_000n);
  assert.equal(parseSol(' 2.5 '), 2_500_000_000n);
  assert.throws(() => parseSol('0.0000000001'), /decimal places/);
  assert.throws(() => parseSol('-1'));
  assert.throws(() => parseSol('1e9'));
  assert.throws(() => parseSol('abc'));
  assert.equal(parseUnits('1.5', 6), 1_500_000n);
  assert.equal(formatSol(1_234_567_890n), '1.23456789');
  assert.equal(formatSol(1_000_000_000n), '1');
  assert.equal(formatSol(1_999_999_999n, 3), '1.999');
  assert.equal(bps(30n, 10_000n), 30);
});

test('toAddress rejects non-canonical or wrong-length input', () => {
  assert.equal(toAddress('11111111111111111111111111111111'), '11111111111111111111111111111111');
  assert.throws(() => toAddress('1111111111111111111111111111111'), /31 bytes|expected 32/);
  assert.throws(() => toAddress('not-base58!'));
  assert.throws(() => toAddress('111111111111111111111111111111111'), /33 bytes|expected 32/);
});

test('isOnCurve agrees with web3.js', () => {
  for (let i = 0; i < 300; i++) {
    const b = new Uint8Array(randomBytes(32));
    assert.equal(isOnCurve(b), PublicKey.isOnCurve(b), `mismatch for ${encodeBase58(b)}`);
  }
  assert.equal(isOnCurve(Keypair.generate().publicKey.toBytes()), true);
});

test('findProgramAddress agrees with web3.js for typical seeds', () => {
  const program = Keypair.generate().publicKey;
  for (let i = 0; i < 50; i++) {
    const seeds = [new Uint8Array(randomBytes(32)), Buffer.from('withdraw')];
    const [theirs, theirBump] = PublicKey.findProgramAddressSync(seeds.map((s) => Buffer.from(s)), program);
    const [ours, ourBump] = findProgramAddress(seeds, toAddress(program.toBase58()));
    assert.equal(ours, theirs.toBase58());
    assert.equal(ourBump, theirBump);
  }
  assert.throws(() => createProgramAddress([new Uint8Array(33)], toAddress(program.toBase58())), /seed too long/);
});

test('signer produces signatures identical to web3.js keypairs and verifiable by ed25519', () => {
  const kp = Keypair.generate();
  const signer = signerFromSecretKey(kp.secretKey);
  assert.equal(signer.address, kp.publicKey.toBase58());
  const msg = new Uint8Array(randomBytes(200));
  const sig = signer.sign(msg);
  assert.equal(sig.length, 64);
  assert.ok(ed25519.verify(sig, msg, kp.publicKey.toBytes()));
  // ed25519 is deterministic: same key + message => same signature as the reference implementation.
  assert.deepEqual(sig, ed25519.sign(msg, kp.secretKey.slice(0, 32)));
  signer.destroy();
  assert.throws(() => signer.sign(msg), /destroyed/);
});

test('corrupt or truncated secret keys are rejected without echoing them', () => {
  const kp = Keypair.generate();
  const corrupt = Uint8Array.from(kp.secretKey);
  corrupt[40] = (corrupt[40]! + 1) % 256;
  assert.throws(() => signerFromSecretKey(corrupt), /corrupt/);
  assert.throws(() => signerFromSecretKey(kp.secretKey.slice(0, 32)), /64 bytes/);
  const material = JSON.stringify([...kp.secretKey]);
  try {
    parseSecretKey(material.slice(0, -3));
    assert.fail('should throw');
  } catch (e) {
    assert.ok(!(e as Error).message.includes(material.slice(1, 20)), 'error must not contain key material');
  }
});

test('secret keys load from JSON array, base58, file and env; env var is scrubbed', () => {
  const kp = Keypair.generate();
  assert.deepEqual(parseSecretKey(JSON.stringify([...kp.secretKey])), kp.secretKey);
  assert.deepEqual(parseSecretKey(encodeBase58(kp.secretKey)), kp.secretKey);

  const env: NodeJS.ProcessEnv = { SOLANA_KEYPAIR: encodeBase58(kp.secretKey) };
  const loaded = loadSignerFromEnv(env);
  assert.equal(loaded.signer.address, kp.publicKey.toBase58());
  assert.equal(env.SOLANA_KEYPAIR, undefined, 'raw key must be removed from the environment after reading');

  const dir = mkdtempSync(join(tmpdir(), 'solprofits-key-'));
  const file = join(dir, 'k.json');
  writeFileSync(file, JSON.stringify([...kp.secretKey]));
  chmodSync(file, 0o644);
  const fromFile = loadSignerFromEnv({ SOLANA_KEYPAIR_PATH: file });
  assert.equal(fromFile.signer.address, kp.publicKey.toBase58());
  assert.ok(fromFile.warnings.some((w) => w.includes('chmod 600')), 'world-readable key file must warn');
  chmodSync(file, 0o600);
  assert.equal(loadSignerFromEnv({ SOLANA_KEYPAIR_PATH: file }).warnings.length, 0);

  assert.throws(() => loadSignerFromEnv({}), /no signing key/);
  assert.throws(() => loadSignerFromEnv({ SOLANA_KEYPAIR_PATH: file, SOLANA_KEYPAIR: 'x' }), /only one/);
});

test('addressToBytes inverts toAddress', () => {
  const kp = Keypair.generate();
  assert.deepEqual(addressToBytes(toAddress(kp.publicKey.toBase58())), kp.publicKey.toBytes());
});
