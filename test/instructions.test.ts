// Transactions and instructions, byte-for-byte against the official clients.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { StakePoolInstruction } from '@solana/spl-stake-pool';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { toAddress, signerFromSecretKey, type Address } from '../src/crypto/keys.ts';
import { compileLegacyMessage, decodeLegacyMessage, signTransaction, type Instruction } from '../src/solana/tx.ts';
import {
  closeTokenAccount,
  createAssociatedTokenAccountIdempotent,
  deriveAssociatedTokenAddress,
  deriveWithdrawAuthority,
  depositSol,
  setComputeUnitLimit,
  setComputeUnitPrice,
  withdrawSol,
} from '../src/solana/programs.ts';
import { encodeBase58 } from '../src/util/base58.ts';
import { readU64le } from '../src/util/bytes.ts';
import { SPL_STAKE_POOL_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../src/solana/constants.ts';

const addr = (p: PublicKey): Address => toAddress(p.toBase58());
const rand = (): PublicKey => Keypair.generate().publicKey;

function toWeb3(ix: Instruction): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((a) => ({ pubkey: new PublicKey(a.address), isSigner: a.isSigner, isWritable: a.isWritable })),
    data: Buffer.from(ix.data),
  });
}

function assertSameInstruction(ours: Instruction, theirs: TransactionInstruction): void {
  assert.equal(ours.programId, theirs.programId.toBase58(), 'program id');
  assert.deepEqual(
    ours.accounts.map((a) => [a.address, a.isSigner, a.isWritable]),
    theirs.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
    'account metas',
  );
  assert.deepEqual([...ours.data], [...theirs.data], 'instruction data');
}

test('compute budget instructions match web3.js', () => {
  assertSameInstruction(setComputeUnitLimit(123_456), ComputeBudgetProgram.setComputeUnitLimit({ units: 123_456 }));
  assertSameInstruction(setComputeUnitPrice(987_654_321n), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 987_654_321n }));
});

test('associated token address + CreateIdempotent + CloseAccount match @solana/spl-token', () => {
  for (let i = 0; i < 20; i++) {
    const owner = rand();
    const mint = rand();
    const ata = getAssociatedTokenAddressSync(mint, owner);
    assert.equal(deriveAssociatedTokenAddress(addr(owner), addr(mint), TOKEN_PROGRAM_ID), ata.toBase58());
    assertSameInstruction(
      createAssociatedTokenAccountIdempotent({ payer: addr(owner), ata: addr(ata), owner: addr(owner), mint: addr(mint), tokenProgram: TOKEN_PROGRAM_ID }),
      createAssociatedTokenAccountIdempotentInstruction(owner, ata, owner, mint),
    );
    assertSameInstruction(
      closeTokenAccount({ account: addr(ata), destination: addr(owner), owner: addr(owner), tokenProgram: TOKEN_PROGRAM_ID }),
      createCloseAccountInstruction(ata, owner, owner),
    );
  }
});

test('stake pool DepositSol and WithdrawSol match @solana/spl-stake-pool', () => {
  const stakePool = rand();
  const [withdrawAuthority] = deriveWithdrawAuthority(SPL_STAKE_POOL_PROGRAM_ID, addr(stakePool));
  const reserve = rand();
  const wallet = rand();
  const ata = rand();
  const feeAcct = rand();
  const mint = rand();
  const lamports = 985_000_000;

  assertSameInstruction(
    depositSol({
      programId: SPL_STAKE_POOL_PROGRAM_ID,
      stakePool: addr(stakePool),
      withdrawAuthority,
      reserveStake: addr(reserve),
      from: addr(wallet),
      destination: addr(ata),
      managerFeeAccount: addr(feeAcct),
      referrer: addr(ata),
      poolMint: addr(mint),
      tokenProgram: TOKEN_PROGRAM_ID,
      lamports: BigInt(lamports),
    }),
    StakePoolInstruction.depositSol({
      stakePool,
      withdrawAuthority: new PublicKey(withdrawAuthority),
      reserveStake: reserve,
      fundingAccount: wallet,
      destinationPoolAccount: ata,
      managerFeeAccount: feeAcct,
      referralPoolAccount: ata,
      poolMint: mint,
      lamports,
    }),
  );

  const poolTokens = 787_654_321;
  assertSameInstruction(
    withdrawSol({
      programId: SPL_STAKE_POOL_PROGRAM_ID,
      stakePool: addr(stakePool),
      withdrawAuthority,
      transferAuthority: addr(wallet),
      source: addr(ata),
      reserveStake: addr(reserve),
      destination: addr(wallet),
      managerFeeAccount: addr(feeAcct),
      poolMint: addr(mint),
      tokenProgram: TOKEN_PROGRAM_ID,
      poolTokens: BigInt(poolTokens),
    }),
    StakePoolInstruction.withdrawSol({
      stakePool,
      withdrawAuthority: new PublicKey(withdrawAuthority),
      sourceTransferAuthority: wallet,
      sourcePoolAccount: ata,
      reserveStake: reserve,
      destinationSystemAccount: wallet,
      managerFeeAccount: feeAcct,
      poolMint: mint,
      poolTokens,
    }),
  );
});

test('slippage-guarded variants: same accounts, Borsh data [25|26, u64, u64] per program source', () => {
  const base = {
    programId: SPL_STAKE_POOL_PROGRAM_ID,
    stakePool: addr(rand()),
    withdrawAuthority: addr(rand()),
    reserveStake: addr(rand()),
    managerFeeAccount: addr(rand()),
    poolMint: addr(rand()),
    tokenProgram: TOKEN_PROGRAM_ID,
  };
  const wallet = addr(rand());
  const ata = addr(rand());
  const legacy = depositSol({ ...base, from: wallet, destination: ata, referrer: ata, lamports: 5n });
  const guarded = depositSol({ ...base, from: wallet, destination: ata, referrer: ata, lamports: 5n, minimumPoolTokensOut: 4n });
  assert.deepEqual(guarded.accounts, legacy.accounts);
  assert.equal(guarded.data.length, 17);
  assert.equal(guarded.data[0], 25);
  assert.equal(readU64le(guarded.data, 1), 5n);
  assert.equal(readU64le(guarded.data, 9), 4n);

  const w = { ...base, transferAuthority: wallet, source: ata, destination: wallet, poolTokens: 7n };
  const wl = withdrawSol(w);
  const wg = withdrawSol({ ...w, minimumLamportsOut: 6n });
  assert.deepEqual(wg.accounts, wl.accounts);
  assert.equal(wg.data[0], 26);
  assert.equal(readU64le(wg.data, 1), 7n);
  assert.equal(readU64le(wg.data, 9), 6n);
});

test('withdraw authority PDA matches web3.js derivation used by the official client', () => {
  for (let i = 0; i < 10; i++) {
    const pool = rand();
    const [theirs, bump] = PublicKey.findProgramAddressSync([pool.toBuffer(), Buffer.from('withdraw')], new PublicKey(SPL_STAKE_POOL_PROGRAM_ID));
    const [ours, ourBump] = deriveWithdrawAuthority(SPL_STAKE_POOL_PROGRAM_ID, addr(pool));
    assert.equal(ours, theirs.toBase58());
    assert.equal(ourBump, bump);
  }
});

function sampleInstructions(wallet: PublicKey): Instruction[] {
  const mint = rand();
  const ata = getAssociatedTokenAddressSync(mint, wallet);
  return [
    setComputeUnitLimit(60_000),
    setComputeUnitPrice(25_000n),
    createAssociatedTokenAccountIdempotent({ payer: addr(wallet), ata: addr(ata), owner: addr(wallet), mint: addr(mint), tokenProgram: TOKEN_PROGRAM_ID }),
    depositSol({
      programId: SPL_STAKE_POOL_PROGRAM_ID,
      stakePool: addr(rand()),
      withdrawAuthority: addr(rand()),
      reserveStake: addr(rand()),
      from: addr(wallet),
      destination: addr(ata),
      managerFeeAccount: addr(rand()),
      referrer: addr(ata),
      poolMint: addr(mint),
      tokenProgram: TOKEN_PROGRAM_ID,
      lamports: 985_000_000n,
      minimumPoolTokensOut: 780_000_000n,
    }),
  ];
}

test('legacy message compilation and signed transaction are byte-identical to web3.js', () => {
  for (let i = 0; i < 25; i++) {
    const kp = Keypair.generate();
    const ixs = sampleInstructions(kp.publicKey);
    const blockhash = encodeBase58(new Uint8Array(randomBytes(32)));
    const ours = compileLegacyMessage(addr(kp.publicKey), ixs, blockhash);
    const theirs = new TransactionMessage({ payerKey: kp.publicKey, recentBlockhash: blockhash, instructions: ixs.map(toWeb3) }).compileToLegacyMessage();
    assert.deepEqual([...ours.bytes], [...theirs.serialize()], 'message bytes');

    const { tx, signature } = signTransaction(ours, [signerFromSecretKey(kp.secretKey)]);
    const vt = new VersionedTransaction(theirs);
    vt.sign([kp]);
    assert.deepEqual([...tx], [...vt.serialize()], 'signed transaction bytes');
    assert.deepEqual([...signature], [...vt.signatures[0]!]);
  }
});

test('decodeLegacyMessage inverts compileLegacyMessage, including signer/writable flags', () => {
  const kp = Keypair.generate();
  const ixs = sampleInstructions(kp.publicKey);
  const msg = compileLegacyMessage(addr(kp.publicKey), ixs, encodeBase58(new Uint8Array(randomBytes(32))));
  const decoded = decodeLegacyMessage(msg.bytes);
  assert.equal(decoded.instructions.length, ixs.length);
  decoded.instructions.forEach((d, i) => {
    const o = ixs[i]!;
    assert.equal(d.programId, o.programId);
    assert.deepEqual([...d.data], [...o.data]);
    assert.deepEqual(
      d.accounts.map((a) => a.address),
      o.accounts.map((a) => a.address),
    );
    // Message-level flags are the OR across the transaction, so they can only be >= the instruction's.
    d.accounts.forEach((a, j) => {
      if (o.accounts[j]!.isSigner) assert.ok(a.isSigner);
      if (o.accounts[j]!.isWritable) assert.ok(a.isWritable);
    });
  });
  assert.throws(() => decodeLegacyMessage(msg.bytes.slice(0, msg.bytes.length - 1)));
  assert.throws(() => decodeLegacyMessage(Uint8Array.from([...msg.bytes, 0])), /trailing/);
});

test('transactions over the 1232-byte limit are refused', () => {
  const kp = Keypair.generate();
  const big: Instruction = { programId: addr(SystemProgram.programId), accounts: [], data: new Uint8Array(1200) };
  const msg = compileLegacyMessage(addr(kp.publicKey), [big], encodeBase58(new Uint8Array(32).fill(7)));
  assert.throws(() => signTransaction(msg, [signerFromSecretKey(kp.secretKey)]), /max 1232/);
});

test('signing refuses unexpected or missing signers', () => {
  const kp = Keypair.generate();
  const other = Keypair.generate();
  const msg = compileLegacyMessage(addr(kp.publicKey), sampleInstructions(kp.publicKey), encodeBase58(new Uint8Array(32).fill(1)));
  assert.throws(() => signTransaction(msg, [signerFromSecretKey(other.secretKey)]), /not required/);
  assert.throws(() => signTransaction(msg, []), /missing signer/);
});
