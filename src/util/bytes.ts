// Small, dependency-free byte helpers. All integer encodings are little-endian,
// matching Solana / Borsh conventions. u64 values are always bigint.

export const U64_MAX = (1n << 64n) - 1n;

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function u8(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xff) throw new RangeError(`u8 out of range: ${n}`);
  return Uint8Array.of(n);
}

export function u32le(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new RangeError(`u32 out of range: ${n}`);
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, true);
  return out;
}

export function u64le(n: bigint): Uint8Array {
  if (typeof n !== 'bigint' || n < 0n || n > U64_MAX) throw new RangeError(`u64 out of range: ${String(n)}`);
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, n, true);
  return out;
}

function view(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

function need(b: Uint8Array, offset: number, len: number): void {
  if (offset < 0 || offset + len > b.length) {
    throw new RangeError(`read of ${len} bytes at offset ${offset} exceeds buffer length ${b.length}`);
  }
}

export function readU8(b: Uint8Array, offset: number): number {
  need(b, offset, 1);
  return view(b).getUint8(offset);
}

export function readU32le(b: Uint8Array, offset: number): number {
  need(b, offset, 4);
  return view(b).getUint32(offset, true);
}

export function readU64le(b: Uint8Array, offset: number): bigint {
  need(b, offset, 8);
  return view(b).getBigUint64(offset, true);
}

export function readI64le(b: Uint8Array, offset: number): bigint {
  need(b, offset, 8);
  return view(b).getBigInt64(offset, true);
}

/** Solana "compact-u16" / shortvec length prefix. */
export function encodeShortVecLength(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw new RangeError(`shortvec length out of range: ${n}`);
  const out: number[] = [];
  let rem = n;
  for (;;) {
    let elem = rem & 0x7f;
    rem >>= 7;
    if (rem === 0) {
      out.push(elem);
      break;
    }
    elem |= 0x80;
    out.push(elem);
  }
  return Uint8Array.from(out);
}

/** Returns [value, bytesConsumed]. */
export function decodeShortVecLength(b: Uint8Array, offset: number): [number, number] {
  let value = 0;
  let size = 0;
  for (;;) {
    if (size >= 3) throw new RangeError('shortvec length too long');
    const elem = readU8(b, offset + size);
    value |= (elem & 0x7f) << (size * 7);
    size += 1;
    if ((elem & 0x80) === 0) break;
  }
  if (value > 0xffff) throw new RangeError('shortvec length overflow');
  return [value, size];
}

export function toBase64(b: Uint8Array): string {
  return Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('base64');
}

export function fromBase64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64'));
}

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
