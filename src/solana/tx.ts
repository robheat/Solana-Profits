// Legacy (non-versioned) Solana transaction compilation and serialization.
// Account ordering follows @solana/web3.js `CompiledKeys` (insertion order within
// the four signer/writable groups); test/tx.test.ts checks byte equality with it.

import { addressFromBytes, addressToBytes, type Address, type Signer } from '../crypto/keys.ts';
import { decodeBase58 } from '../util/base58.ts';
import { concatBytes, decodeShortVecLength, encodeShortVecLength, readU8 } from '../util/bytes.ts';
import { MAX_TRANSACTION_SIZE } from './constants.ts';

export interface AccountMeta {
  address: Address;
  isSigner: boolean;
  isWritable: boolean;
}

export interface Instruction {
  programId: Address;
  accounts: AccountMeta[];
  data: Uint8Array;
}

export interface CompiledMessage {
  /** Serialized message: exactly the bytes that get signed. */
  bytes: Uint8Array;
  accountKeys: Address[];
  numRequiredSignatures: number;
  numReadonlySignedAccounts: number;
  numReadonlyUnsignedAccounts: number;
  recentBlockhash: string;
}

interface KeyMeta {
  isSigner: boolean;
  isWritable: boolean;
}

export function compileLegacyMessage(payer: Address, instructions: Instruction[], recentBlockhash: string): CompiledMessage {
  const metas = new Map<Address, KeyMeta>();
  const getOrInsert = (a: Address): KeyMeta => {
    let m = metas.get(a);
    if (!m) {
      m = { isSigner: false, isWritable: false };
      metas.set(a, m);
    }
    return m;
  };
  const payerMeta = getOrInsert(payer);
  payerMeta.isSigner = true;
  payerMeta.isWritable = true;
  for (const ix of instructions) {
    getOrInsert(ix.programId);
    for (const acc of ix.accounts) {
      const m = getOrInsert(acc.address);
      m.isSigner ||= acc.isSigner;
      m.isWritable ||= acc.isWritable;
    }
  }

  const entries = [...metas.entries()];
  const writableSigners = entries.filter(([, m]) => m.isSigner && m.isWritable).map(([a]) => a);
  const readonlySigners = entries.filter(([, m]) => m.isSigner && !m.isWritable).map(([a]) => a);
  const writableNonSigners = entries.filter(([, m]) => !m.isSigner && m.isWritable).map(([a]) => a);
  const readonlyNonSigners = entries.filter(([, m]) => !m.isSigner && !m.isWritable).map(([a]) => a);
  if (writableSigners[0] !== payer) throw new Error('fee payer must be the first writable signer');

  const accountKeys = [...writableSigners, ...readonlySigners, ...writableNonSigners, ...readonlyNonSigners];
  if (accountKeys.length > 256) throw new Error('too many account keys');
  const index = new Map<Address, number>(accountKeys.map((a, i) => [a, i]));

  const blockhashBytes = decodeBase58(recentBlockhash);
  if (blockhashBytes.length !== 32) throw new Error('recent blockhash must be 32 bytes');

  const parts: Uint8Array[] = [
    Uint8Array.of(writableSigners.length + readonlySigners.length, readonlySigners.length, readonlyNonSigners.length),
    encodeShortVecLength(accountKeys.length),
    ...accountKeys.map(addressToBytes),
    blockhashBytes,
    encodeShortVecLength(instructions.length),
  ];
  for (const ix of instructions) {
    const programIndex = index.get(ix.programId);
    if (programIndex === undefined) throw new Error('internal: program id missing from account keys');
    parts.push(Uint8Array.of(programIndex));
    parts.push(encodeShortVecLength(ix.accounts.length));
    parts.push(
      Uint8Array.from(
        ix.accounts.map((acc) => {
          const i = index.get(acc.address);
          if (i === undefined) throw new Error('internal: account missing from account keys');
          return i;
        }),
      ),
    );
    parts.push(encodeShortVecLength(ix.data.length));
    parts.push(ix.data);
  }

  return {
    bytes: concatBytes(...parts),
    accountKeys,
    numRequiredSignatures: writableSigners.length + readonlySigners.length,
    numReadonlySignedAccounts: readonlySigners.length,
    numReadonlyUnsignedAccounts: readonlyNonSigners.length,
    recentBlockhash,
  };
}

/** Wire format: shortvec(signature count) || signatures || message. */
export function serializeTransaction(message: CompiledMessage, signatures: Uint8Array[]): Uint8Array {
  if (signatures.length !== message.numRequiredSignatures) {
    throw new Error(`expected ${message.numRequiredSignatures} signatures, got ${signatures.length}`);
  }
  for (const s of signatures) if (s.length !== 64) throw new Error('signatures must be 64 bytes');
  const tx = concatBytes(encodeShortVecLength(signatures.length), ...signatures, message.bytes);
  if (tx.length > MAX_TRANSACTION_SIZE) throw new Error(`transaction is ${tx.length} bytes, max ${MAX_TRANSACTION_SIZE}`);
  return tx;
}

/** Placeholder signatures for simulation with sigVerify=false. */
export function unsignedTransaction(message: CompiledMessage): Uint8Array {
  return serializeTransaction(
    message,
    Array.from({ length: message.numRequiredSignatures }, () => new Uint8Array(64)),
  );
}

export function signTransaction(message: CompiledMessage, signers: Signer[]): { tx: Uint8Array; signature: Uint8Array } {
  const required = message.accountKeys.slice(0, message.numRequiredSignatures);
  const byAddress = new Map(signers.map((s) => [s.address, s]));
  for (const s of signers) {
    if (!required.includes(s.address)) throw new Error(`signer ${s.address} is not required by this transaction`);
  }
  const signatures = required.map((a) => {
    const signer = byAddress.get(a);
    if (!signer) throw new Error(`missing signer for ${a}`);
    return signer.sign(message.bytes);
  });
  const first = signatures[0];
  if (!first) throw new Error('transaction has no signatures');
  return { tx: serializeTransaction(message, signatures), signature: first };
}

export interface DecodedInstruction {
  programId: Address;
  accounts: AccountMeta[];
  data: Uint8Array;
}

export interface DecodedMessage {
  numRequiredSignatures: number;
  numReadonlySignedAccounts: number;
  numReadonlyUnsignedAccounts: number;
  accountKeys: Address[];
  recentBlockhash: string;
  instructions: DecodedInstruction[];
}

/**
 * Independent decoder for legacy message bytes. The transaction firewall runs on
 * the output of this function, i.e. on what will actually be signed, not on the
 * builder's intent.
 */
export function decodeLegacyMessage(bytes: Uint8Array): DecodedMessage {
  let o = 0;
  const numRequiredSignatures = readU8(bytes, o++);
  const numReadonlySignedAccounts = readU8(bytes, o++);
  const numReadonlyUnsignedAccounts = readU8(bytes, o++);
  if (numRequiredSignatures & 0x80) throw new Error('versioned messages are not supported');
  const [keyCount, keyLenSize] = decodeShortVecLength(bytes, o);
  o += keyLenSize;
  const accountKeys: Address[] = [];
  for (let i = 0; i < keyCount; i++) {
    if (o + 32 > bytes.length) throw new Error('truncated account keys');
    accountKeys.push(addressFromBytes(bytes.slice(o, o + 32)));
    o += 32;
  }
  if (o + 32 > bytes.length) throw new Error('truncated blockhash');
  const recentBlockhash = addressFromBytes(bytes.slice(o, o + 32)) as string;
  o += 32;
  if (numRequiredSignatures > keyCount || numReadonlySignedAccounts > numRequiredSignatures) {
    throw new Error('invalid message header');
  }
  if (numReadonlyUnsignedAccounts > keyCount - numRequiredSignatures) throw new Error('invalid message header');

  const isSigner = (i: number) => i < numRequiredSignatures;
  const isWritable = (i: number) =>
    i < numRequiredSignatures
      ? i < numRequiredSignatures - numReadonlySignedAccounts
      : i < keyCount - numReadonlyUnsignedAccounts;

  const [ixCount, ixLenSize] = decodeShortVecLength(bytes, o);
  o += ixLenSize;
  const instructions: DecodedInstruction[] = [];
  for (let n = 0; n < ixCount; n++) {
    const programIndex = readU8(bytes, o++);
    const programId = accountKeys[programIndex];
    if (!programId) throw new Error('program index out of range');
    const [accCount, accLenSize] = decodeShortVecLength(bytes, o);
    o += accLenSize;
    const accounts: AccountMeta[] = [];
    for (let i = 0; i < accCount; i++) {
      const idx = readU8(bytes, o++);
      const address = accountKeys[idx];
      if (!address) throw new Error('account index out of range');
      accounts.push({ address, isSigner: isSigner(idx), isWritable: isWritable(idx) });
    }
    const [dataLen, dataLenSize] = decodeShortVecLength(bytes, o);
    o += dataLenSize;
    if (o + dataLen > bytes.length) throw new Error('truncated instruction data');
    instructions.push({ programId, accounts, data: bytes.slice(o, o + dataLen) });
    o += dataLen;
  }
  if (o !== bytes.length) throw new Error('trailing bytes after message');
  return {
    numRequiredSignatures,
    numReadonlySignedAccounts,
    numReadonlyUnsignedAccounts,
    accountKeys,
    recentBlockhash,
    instructions,
  };
}
