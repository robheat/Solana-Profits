// Addresses, program-derived addresses and ed25519 signing.
//
// Secret keys are only ever held inside a Signer closure, never logged, and can
// be wiped with destroy(). Read-only commands never construct a Signer at all.

import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { readFileSync, statSync } from 'node:fs';
import { decodeBase58, encodeBase58 } from '../util/base58.ts';
import { bytesEqual, concatBytes, utf8 } from '../util/bytes.ts';

export type Address = string & { readonly __brand: 'Address' };

/** Validates that `value` is a canonical base58 encoding of 32 bytes. */
export function toAddress(value: string): Address {
  let bytes: Uint8Array;
  try {
    bytes = decodeBase58(value);
  } catch {
    throw new Error(`invalid address "${value}": not base58`);
  }
  if (bytes.length !== 32) throw new Error(`invalid address "${value}": decodes to ${bytes.length} bytes, expected 32`);
  if (encodeBase58(bytes) !== value) throw new Error(`invalid address "${value}": non-canonical encoding`);
  return value as Address;
}

export function addressToBytes(address: Address): Uint8Array {
  const bytes = decodeBase58(address);
  if (bytes.length !== 32) throw new Error(`invalid address ${address}`);
  return bytes;
}

export function addressFromBytes(bytes: Uint8Array): Address {
  if (bytes.length !== 32) throw new Error(`address must be 32 bytes, got ${bytes.length}`);
  return encodeBase58(bytes) as Address;
}

/** True if the 32 bytes decode to a point on the ed25519 curve (i.e. could have a private key). */
export function isOnCurve(bytes: Uint8Array): boolean {
  try {
    // zip215=true mirrors curve25519-dalek's permissive decompression used by the Solana runtime.
    ed25519.Point.fromBytes(bytes, true);
    return true;
  } catch {
    return false;
  }
}

const PDA_MARKER = utf8('ProgramDerivedAddress');
const MAX_SEED_LENGTH = 32;
const MAX_SEEDS = 16;

export function createProgramAddress(seeds: Uint8Array[], programId: Address): Address {
  if (seeds.length > MAX_SEEDS) throw new Error('too many seeds');
  for (const s of seeds) if (s.length > MAX_SEED_LENGTH) throw new Error('seed too long');
  const hash = sha256(concatBytes(...seeds, addressToBytes(programId), PDA_MARKER));
  if (isOnCurve(hash)) throw new Error('invalid seeds: derived address is on the ed25519 curve');
  return addressFromBytes(hash);
}

export function findProgramAddress(seeds: Uint8Array[], programId: Address): [Address, number] {
  for (let bump = 255; bump >= 0; bump--) {
    try {
      return [createProgramAddress([...seeds, Uint8Array.of(bump)], programId), bump];
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('invalid seeds')) continue;
      throw e;
    }
  }
  throw new Error('unable to find a viable program address bump seed');
}

export interface Signer {
  readonly address: Address;
  sign(message: Uint8Array): Uint8Array;
  /** Best-effort wipe of the secret key bytes held by this signer. */
  destroy(): void;
}

/**
 * Builds a Signer from a 64-byte Solana secret key (32-byte seed || 32-byte public key),
 * verifying that the embedded public key really belongs to the seed.
 */
export function signerFromSecretKey(secretKey: Uint8Array): Signer {
  if (secretKey.length !== 64) {
    throw new Error(`secret key must be 64 bytes (got ${secretKey.length}); export the full keypair, not a seed`);
  }
  const seed = secretKey.slice(0, 32);
  const embeddedPublic = secretKey.slice(32, 64);
  const derivedPublic = ed25519.getPublicKey(seed);
  if (!bytesEqual(derivedPublic, embeddedPublic)) {
    seed.fill(0);
    throw new Error('secret key is corrupt: its public half does not match its private half');
  }
  const address = addressFromBytes(derivedPublic);
  let destroyed = false;
  return {
    address,
    sign(message: Uint8Array): Uint8Array {
      if (destroyed) throw new Error('signer has been destroyed');
      return ed25519.sign(message, seed);
    },
    destroy(): void {
      seed.fill(0);
      destroyed = true;
    },
  };
}

/**
 * Parses key material in either solana-keygen JSON form ("[12,34,...]") or as a
 * base58 string (the format wallets such as Phantom export). Never echoes the input.
 */
export function parseSecretKey(material: string): Uint8Array {
  const text = material.trim();
  if (text.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('keypair JSON could not be parsed');
    }
    if (!Array.isArray(parsed) || !parsed.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
      throw new Error('keypair JSON must be an array of byte values');
    }
    return Uint8Array.from(parsed as number[]);
  }
  try {
    return decodeBase58(text);
  } catch {
    throw new Error('secret key is neither a JSON byte array nor base58');
  }
}

export interface LoadedKey {
  signer: Signer;
  source: string;
  warnings: string[];
}

/**
 * Loads the signing key from SOLANA_KEYPAIR_PATH (preferred) or SOLANA_KEYPAIR.
 * The environment variable holding raw key material is removed from process.env
 * once read so nothing launched later can inherit it.
 */
export function loadSignerFromEnv(env: NodeJS.ProcessEnv = process.env): LoadedKey {
  const warnings: string[] = [];
  const path = env.SOLANA_KEYPAIR_PATH;
  const inline = env.SOLANA_KEYPAIR;
  if (path && inline) throw new Error('set only one of SOLANA_KEYPAIR_PATH or SOLANA_KEYPAIR');
  let secret: Uint8Array;
  let source: string;
  if (path) {
    const st = statSync(path);
    if ((st.mode & 0o077) !== 0) {
      warnings.push(`keypair file ${path} is readable by other users; run: chmod 600 ${path}`);
    }
    secret = parseSecretKey(readFileSync(path, 'utf8'));
    source = `file ${path}`;
  } else if (inline) {
    secret = parseSecretKey(inline);
    delete env.SOLANA_KEYPAIR;
    source = 'SOLANA_KEYPAIR environment variable';
  } else {
    throw new Error('no signing key configured: set SOLANA_KEYPAIR_PATH (preferred) or SOLANA_KEYPAIR');
  }
  try {
    return { signer: signerFromSecretKey(secret), source, warnings };
  } finally {
    secret.fill(0);
  }
}
