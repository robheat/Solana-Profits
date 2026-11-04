// Bitcoin-alphabet base58 (the encoding Solana uses for addresses, blockhashes,
// signatures and exported secret keys). Same algorithm as the widely used
// `base-x` package; cross-checked against `bs58` in test/base58.test.ts.

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const LOOKUP = new Int16Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) LOOKUP[ALPHABET.charCodeAt(i)] = i;

const FACTOR = Math.log(256) / Math.log(58); // ≈ 1.365
const IFACTOR = Math.log(58) / Math.log(256); // ≈ 0.732

export function encodeBase58(source: Uint8Array): string {
  if (source.length === 0) return '';
  let zeroes = 0;
  while (zeroes < source.length && source[zeroes] === 0) zeroes++;

  const size = Math.floor((source.length - zeroes) * FACTOR + 1);
  const b58 = new Uint8Array(size);
  let length = 0;

  for (let i = zeroes; i < source.length; i++) {
    let carry = source[i] as number;
    let j = 0;
    for (let k = size - 1; (carry !== 0 || j < length) && k >= 0; k--, j++) {
      carry += 256 * (b58[k] as number);
      b58[k] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    if (carry !== 0) throw new Error('base58: non-zero carry');
    length = j;
  }

  let it = size - length;
  while (it < size && b58[it] === 0) it++;

  let out = '1'.repeat(zeroes);
  for (; it < size; it++) out += ALPHABET[b58[it] as number];
  return out;
}

export function decodeBase58(source: string): Uint8Array {
  if (typeof source !== 'string') throw new TypeError('base58: expected string');
  if (source.length === 0) return new Uint8Array(0);

  let zeroes = 0;
  while (zeroes < source.length && source[zeroes] === '1') zeroes++;

  const size = Math.floor((source.length - zeroes) * IFACTOR + 1);
  const b256 = new Uint8Array(size);
  let length = 0;

  for (let i = zeroes; i < source.length; i++) {
    const code = source.charCodeAt(i);
    const value = code < 128 ? (LOOKUP[code] as number) : -1;
    if (value === -1) throw new Error(`base58: invalid character at position ${i}`);
    let carry = value;
    let j = 0;
    for (let k = size - 1; (carry !== 0 || j < length) && k >= 0; k--, j++) {
      carry += 58 * (b256[k] as number);
      b256[k] = carry % 256;
      carry = Math.floor(carry / 256);
    }
    if (carry !== 0) throw new Error('base58: non-zero carry');
    length = j;
  }

  let it = size - length;
  while (it < size && b256[it] === 0) it++;

  const out = new Uint8Array(zeroes + (size - it));
  out.set(b256.subarray(it), zeroes);
  return out;
}
