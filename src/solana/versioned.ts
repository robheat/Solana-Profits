// Versioned (v0) transactions as returned by swap aggregators: decode, resolve
// address lookup tables, and add our signature to an externally built transaction.
// Cross-checked against @solana/web3.js in test/versioned.test.ts.

import { addressFromBytes, type Address, type Signer } from '../crypto/keys.ts';
import { concatBytes, decodeShortVecLength, encodeShortVecLength, readU64le, readU8, readU32le } from '../util/bytes.ts';
import { MAX_TRANSACTION_SIZE } from './constants.ts';
import type { AccountMeta } from './tx.ts';

export interface CompiledInstructionRef {
  programIdIndex: number;
  accountIndexes: number[];
  data: Uint8Array;
}

export interface AddressTableLookup {
  accountKey: Address;
  writableIndexes: number[];
  readonlyIndexes: number[];
}

export interface VersionedMessageView {
  version: 'legacy' | 0;
  numRequiredSignatures: number;
  numReadonlySignedAccounts: number;
  numReadonlyUnsignedAccounts: number;
  staticAccountKeys: Address[];
  recentBlockhash: string;
  instructions: CompiledInstructionRef[];
  addressTableLookups: AddressTableLookup[];
}

function readKeys(bytes: Uint8Array, o: number, count: number): [Address[], number] {
  const out: Address[] = [];
  for (let i = 0; i < count; i++) {
    if (o + 32 > bytes.length) throw new Error('truncated account keys');
    out.push(addressFromBytes(bytes.slice(o, o + 32)));
    o += 32;
  }
  return [out, o];
}

function readIndexList(bytes: Uint8Array, o: number): [number[], number] {
  const [n, size] = decodeShortVecLength(bytes, o);
  o += size;
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(readU8(bytes, o++));
  return [out, o];
}

/** Decodes legacy or v0 message bytes (the bytes that are signed). */
export function decodeVersionedMessage(bytes: Uint8Array): VersionedMessageView {
  let o = 0;
  const first = readU8(bytes, 0);
  let version: 'legacy' | 0 = 'legacy';
  if (first & 0x80) {
    const v = first & 0x7f;
    if (v !== 0) throw new Error(`unsupported message version ${v}`);
    version = 0;
    o = 1;
  }
  const numRequiredSignatures = readU8(bytes, o++);
  const numReadonlySignedAccounts = readU8(bytes, o++);
  const numReadonlyUnsignedAccounts = readU8(bytes, o++);
  const [keyCount, keySize] = decodeShortVecLength(bytes, o);
  o += keySize;
  let staticAccountKeys: Address[];
  [staticAccountKeys, o] = readKeys(bytes, o, keyCount);
  if (o + 32 > bytes.length) throw new Error('truncated blockhash');
  const recentBlockhash = addressFromBytes(bytes.slice(o, o + 32)) as string;
  o += 32;
  if (numRequiredSignatures > keyCount || numReadonlySignedAccounts > numRequiredSignatures) throw new Error('invalid message header');
  if (numReadonlyUnsignedAccounts > keyCount - numRequiredSignatures) throw new Error('invalid message header');

  const [ixCount, ixSize] = decodeShortVecLength(bytes, o);
  o += ixSize;
  const instructions: CompiledInstructionRef[] = [];
  for (let n = 0; n < ixCount; n++) {
    const programIdIndex = readU8(bytes, o++);
    let accountIndexes: number[];
    [accountIndexes, o] = readIndexList(bytes, o);
    const [dataLen, dataSize] = decodeShortVecLength(bytes, o);
    o += dataSize;
    if (o + dataLen > bytes.length) throw new Error('truncated instruction data');
    instructions.push({ programIdIndex, accountIndexes, data: bytes.slice(o, o + dataLen) });
    o += dataLen;
  }

  const addressTableLookups: AddressTableLookup[] = [];
  if (version === 0) {
    const [lookupCount, lookupSize] = decodeShortVecLength(bytes, o);
    o += lookupSize;
    for (let n = 0; n < lookupCount; n++) {
      if (o + 32 > bytes.length) throw new Error('truncated lookup table key');
      const accountKey = addressFromBytes(bytes.slice(o, o + 32));
      o += 32;
      let writableIndexes: number[];
      let readonlyIndexes: number[];
      [writableIndexes, o] = readIndexList(bytes, o);
      [readonlyIndexes, o] = readIndexList(bytes, o);
      addressTableLookups.push({ accountKey, writableIndexes, readonlyIndexes });
    }
  }
  if (o !== bytes.length) throw new Error('trailing bytes after message');
  return {
    version,
    numRequiredSignatures,
    numReadonlySignedAccounts,
    numReadonlyUnsignedAccounts,
    staticAccountKeys,
    recentBlockhash,
    instructions,
    addressTableLookups,
  };
}

export interface LookupTable {
  deactivationSlot: bigint;
  authority: Address | null;
  addresses: Address[];
}

export const ADDRESS_LOOKUP_TABLE_PROGRAM_ID = 'AddressLookupTab1e1111111111111111111111111' as Address;
const LOOKUP_TABLE_META_SIZE = 56;

/** Address lookup table account: bincode ProgramState::LookupTable(meta) padded to 56 bytes, then addresses. */
export function decodeLookupTable(data: Uint8Array): LookupTable {
  if (data.length < LOOKUP_TABLE_META_SIZE || (data.length - LOOKUP_TABLE_META_SIZE) % 32 !== 0) {
    throw new Error('invalid lookup table account size');
  }
  if (readU32le(data, 0) !== 1) throw new Error('account is not an initialized lookup table');
  const deactivationSlot = readU64le(data, 4);
  const hasAuthority = readU8(data, 21);
  const authority = hasAuthority === 1 ? addressFromBytes(data.slice(22, 54)) : null;
  const addresses: Address[] = [];
  for (let o = LOOKUP_TABLE_META_SIZE; o < data.length; o += 32) addresses.push(addressFromBytes(data.slice(o, o + 32)));
  return { deactivationSlot, authority, addresses };
}

export interface ResolvedInstruction {
  programId: Address;
  accounts: AccountMeta[];
  data: Uint8Array;
}

export interface ResolvedMessage {
  view: VersionedMessageView;
  /** static keys, then loaded writable, then loaded readonly (the runtime's index order). */
  accountKeys: Address[];
  signers: Address[];
  writable: Set<Address>;
  instructions: ResolvedInstruction[];
}

/** Resolves every account index (including lookup-table ones) to an address with signer/writable flags. */
export function resolveMessage(view: VersionedMessageView, tables: Map<Address, LookupTable>): ResolvedMessage {
  const loadedWritable: Address[] = [];
  const loadedReadonly: Address[] = [];
  for (const lookup of view.addressTableLookups) {
    const table = tables.get(lookup.accountKey);
    if (!table) throw new Error(`lookup table ${lookup.accountKey} was not provided`);
    const pick = (i: number): Address => {
      const a = table.addresses[i];
      if (!a) throw new Error(`lookup table ${lookup.accountKey} has no index ${i}`);
      return a;
    };
    loadedWritable.push(...lookup.writableIndexes.map(pick));
    loadedReadonly.push(...lookup.readonlyIndexes.map(pick));
  }
  const s = view.staticAccountKeys;
  const accountKeys = [...s, ...loadedWritable, ...loadedReadonly];
  const isSigner = (i: number) => i < view.numRequiredSignatures;
  const isWritable = (i: number): boolean => {
    if (i < view.numRequiredSignatures) return i < view.numRequiredSignatures - view.numReadonlySignedAccounts;
    if (i < s.length) return i < s.length - view.numReadonlyUnsignedAccounts;
    return i < s.length + loadedWritable.length;
  };
  const writable = new Set<Address>();
  accountKeys.forEach((a, i) => {
    if (isWritable(i)) writable.add(a);
  });
  const instructions = view.instructions.map((ix) => {
    const programId = accountKeys[ix.programIdIndex];
    if (!programId) throw new Error('program index out of range');
    if (ix.programIdIndex >= s.length) throw new Error('program id must be a static account key');
    return {
      programId,
      accounts: ix.accountIndexes.map((i) => {
        const address = accountKeys[i];
        if (!address) throw new Error('account index out of range');
        return { address, isSigner: isSigner(i), isWritable: isWritable(i) };
      }),
      data: ix.data,
    };
  });
  return { view, accountKeys, signers: s.slice(0, view.numRequiredSignatures), writable, instructions };
}

export interface RawTransaction {
  signatures: Uint8Array[];
  messageBytes: Uint8Array;
}

export function decodeRawTransaction(tx: Uint8Array): RawTransaction {
  const [count, size] = decodeShortVecLength(tx, 0);
  let o = size;
  const signatures: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    if (o + 64 > tx.length) throw new Error('truncated signatures');
    signatures.push(tx.slice(o, o + 64));
    o += 64;
  }
  return { signatures, messageBytes: tx.slice(o) };
}

/** Adds `signer`'s signature to a transaction built elsewhere (e.g. by an aggregator API). */
export function signRawTransaction(tx: Uint8Array, signer: Signer): { tx: Uint8Array; signature: Uint8Array } {
  const raw = decodeRawTransaction(tx);
  const view = decodeVersionedMessage(raw.messageBytes);
  if (raw.signatures.length !== view.numRequiredSignatures) throw new Error('signature count does not match the message header');
  const index = view.staticAccountKeys.slice(0, view.numRequiredSignatures).indexOf(signer.address);
  if (index < 0) throw new Error(`transaction does not require a signature from ${signer.address}`);
  const signature = signer.sign(raw.messageBytes);
  const signatures = raw.signatures.map((s, i) => (i === index ? signature : s));
  const out = concatBytes(encodeShortVecLength(signatures.length), ...signatures, raw.messageBytes);
  if (out.length > MAX_TRANSACTION_SIZE) throw new Error(`transaction is ${out.length} bytes, max ${MAX_TRANSACTION_SIZE}`);
  return { tx: out, signature };
}
