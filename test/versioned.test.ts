// v0 messages, address lookup tables and raw-transaction signing vs @solana/web3.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  AddressLookupTableAccount,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { decodeLookupTable, decodeRawTransaction, decodeVersionedMessage, resolveMessage, signRawTransaction, type LookupTable } from '../src/solana/versioned.ts';
import { signerFromSecretKey, toAddress, type Address } from '../src/crypto/keys.ts';
import { concatBytes, u32le, u64le } from '../src/util/bytes.ts';
import { encodeBase58 } from '../src/util/base58.ts';

const rand = () => Keypair.generate().publicKey;

function lookupTableData(addresses: PublicKey[], authority: PublicKey | null): Uint8Array {
  const meta = new Uint8Array(56);
  meta.set(u32le(1), 0);
  meta.set(u64le(2n ** 64n - 1n), 4); // not deactivated
  meta.set(u64le(123n), 12);
  meta[20] = 0;
  if (authority) {
    meta[21] = 1;
    meta.set(authority.toBytes(), 22);
  }
  return concatBytes(meta, ...addresses.map((a) => a.toBytes()));
}

test('lookup table decoding matches web3.js', () => {
  const addresses = Array.from({ length: 40 }, rand);
  const auth = rand();
  const data = lookupTableData(addresses, auth);
  const theirs = AddressLookupTableAccount.deserialize(data);
  const ours = decodeLookupTable(data);
  assert.deepEqual(ours.addresses, theirs.addresses.map((a) => a.toBase58()));
  assert.equal(ours.authority, theirs.authority?.toBase58() ?? null);
  assert.equal(ours.deactivationSlot, BigInt(theirs.deactivationSlot.toString()));
  assert.equal(decodeLookupTable(lookupTableData(addresses, null)).authority, null);
  assert.throws(() => decodeLookupTable(data.slice(0, 60)), /size/);
});

test('v0 messages with lookup tables decode and resolve exactly like web3.js compiled them', () => {
  for (let round = 0; round < 15; round++) {
    const payer = Keypair.generate();
    const tableAddrs = Array.from({ length: 30 }, rand);
    const table = new AddressLookupTableAccount({ key: rand(), state: AddressLookupTableAccount.deserialize(lookupTableData(tableAddrs, null)) });
    const programA = rand();
    const ixs = [
      new TransactionInstruction({
        programId: programA,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: tableAddrs[3]!, isSigner: false, isWritable: true },
          { pubkey: tableAddrs[7]!, isSigner: false, isWritable: false },
          { pubkey: rand(), isSigner: false, isWritable: true },
        ],
        data: Buffer.from(randomBytes(20)),
      }),
      new TransactionInstruction({
        programId: rand(),
        keys: [
          { pubkey: tableAddrs[11]!, isSigner: false, isWritable: false },
          { pubkey: tableAddrs[3]!, isSigner: false, isWritable: true },
        ],
        data: Buffer.from([1, 2, 3]),
      }),
    ];
    const blockhash = encodeBase58(new Uint8Array(randomBytes(32)));
    const v0 = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message([table]);
    const bytes = v0.serialize();
    const view = decodeVersionedMessage(bytes);
    assert.equal(view.version, 0);
    assert.equal(view.addressTableLookups.length, 1);
    assert.deepEqual(view.staticAccountKeys, v0.staticAccountKeys.map((k) => k.toBase58()));

    const tables = new Map<Address, LookupTable>([[toAddress(table.key.toBase58()), decodeLookupTable(lookupTableData(tableAddrs, null))]]);
    const resolved = resolveMessage(view, tables);
    const theirKeys = v0.getAccountKeys({ addressLookupTableAccounts: [table] });
    assert.deepEqual(resolved.accountKeys, [...Array(theirKeys.length).keys()].map((i) => theirKeys.get(i)!.toBase58()));
    resolved.instructions.forEach((ix, n) => {
      const orig = ixs[n]!;
      assert.equal(ix.programId, orig.programId.toBase58());
      assert.deepEqual(ix.accounts.map((a) => a.address), orig.keys.map((k) => k.pubkey.toBase58()));
      assert.deepEqual([...ix.data], [...orig.data]);
      ix.accounts.forEach((a, j) => {
        assert.equal(a.isWritable, v0.isAccountWritable(v0.compiledInstructions[n]!.accountKeyIndexes[j]!), 'writable flag');
        assert.equal(a.isSigner, v0.isAccountSigner(v0.compiledInstructions[n]!.accountKeyIndexes[j]!), 'signer flag');
      });
    });
    assert.deepEqual(resolved.signers, [payer.publicKey.toBase58()]);
    assert.throws(() => resolveMessage(view, new Map()), /was not provided/);
  }
});

test('legacy messages also decode through the versioned decoder', () => {
  const payer = Keypair.generate();
  const msg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: encodeBase58(new Uint8Array(32).fill(3)),
    instructions: [new TransactionInstruction({ programId: rand(), keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: true }], data: Buffer.from([9]) })],
  }).compileToLegacyMessage();
  const view = decodeVersionedMessage(msg.serialize());
  assert.equal(view.version, 'legacy');
  assert.equal(view.addressTableLookups.length, 0);
});

test('signRawTransaction produces exactly the bytes web3.js produces when signing', () => {
  const kp = Keypair.generate();
  const table = new AddressLookupTableAccount({ key: rand(), state: AddressLookupTableAccount.deserialize(lookupTableData(Array.from({ length: 5 }, rand), null)) });
  const v0 = new TransactionMessage({
    payerKey: kp.publicKey,
    recentBlockhash: encodeBase58(new Uint8Array(randomBytes(32))),
    instructions: [new TransactionInstruction({ programId: rand(), keys: [{ pubkey: table.state.addresses[2]!, isSigner: false, isWritable: true }], data: Buffer.from([7, 7]) })],
  }).compileToV0Message([table]);
  const unsigned = new VersionedTransaction(v0).serialize(); // zero signature, as aggregators return it
  const { tx } = signRawTransaction(unsigned, signerFromSecretKey(kp.secretKey));
  const vt = new VersionedTransaction(v0);
  vt.sign([kp]);
  assert.deepEqual([...tx], [...vt.serialize()]);
  assert.equal(decodeRawTransaction(tx).signatures.length, 1);
  assert.throws(() => signRawTransaction(unsigned, signerFromSecretKey(Keypair.generate().secretKey)), /does not require/);
});
