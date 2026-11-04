// Exact decimal <-> integer conversion for SOL and SPL token amounts.
// Money never goes through floating point on its way into a transaction.

export const LAMPORTS_PER_SOL = 1_000_000_000n;

/** Parse a decimal string such as "0.01" into base units with `decimals` places. */
export function parseUnits(value: string, decimals: number): bigint {
  if (typeof value !== 'string') throw new TypeError('amount must be a decimal string');
  const s = value.trim();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error(`invalid amount "${value}": expected a non-negative decimal like 0.25`);
  const whole = m[1] as string;
  const frac = m[2] ?? '';
  if (frac.length > decimals) {
    throw new Error(`invalid amount "${value}": more than ${decimals} decimal places`);
  }
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
}

export function formatUnits(value: bigint, decimals: number, maxFractionDigits = decimals): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  let frac = (abs % base).toString().padStart(decimals, '0');
  if (maxFractionDigits < decimals) frac = frac.slice(0, maxFractionDigits);
  frac = frac.replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole.toString()}${frac ? '.' + frac : ''}`;
}

export function parseSol(value: string): bigint {
  return parseUnits(value, 9);
}

export function formatSol(lamports: bigint, maxFractionDigits = 9): string {
  return formatUnits(lamports, 9, maxFractionDigits);
}

/** Basis points of `part` relative to `whole`, as a float for display/thresholds. */
export function bps(part: bigint, whole: bigint): number {
  if (whole === 0n) return 0;
  // Scale before dividing to keep precision without floats on the inputs.
  return Number((part * 1_000_000n) / whole) / 100;
}

export function bigintMin(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export function bigintMax(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
