// Deterministic synthetic SOL/USD hourly series for router tests.

import type { PriceBar } from '../src/router/prices.ts';

const H = 3_600_000;

/** Flat for `flatHours`, then a constant drift to `endMultiple`, with a small deterministic wiggle. */
export function series(hours: number, flatHours: number, endMultiple: number, opts: { start?: number; t0?: number; wiggle?: number } = {}): PriceBar[] {
  let seed = 42;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648 - 0.5;
  };
  const wiggle = opts.wiggle ?? 0.002;
  const t0 = opts.t0 ?? Date.parse('2026-01-01T00:00:00Z');
  const drift = Math.log(endMultiple) / Math.max(1, hours - flatHours);
  const out: PriceBar[] = [];
  let p = opts.start ?? 150;
  for (let h = 0; h < hours; h++) {
    p *= Math.exp((h >= flatHours ? drift : 0) + wiggle * rnd());
    out.push({ t: t0 + h * H, close: p });
  }
  return out;
}

/** A series of `hours` bars ending exactly at `endMs` (hour-aligned) with last close `endPrice`. */
export function seriesEndingAt(endMs: number, endPrice: number, hours: number, flatHours: number, endMultiple: number): PriceBar[] {
  const end = Math.floor(endMs / H) * H;
  const raw = series(hours, flatHours, endMultiple, { t0: end - (hours - 1) * H });
  const scale = endPrice / raw[raw.length - 1]!.close;
  return raw.map((b) => ({ t: b.t, close: b.close * scale }));
}

export function toCsv(bars: PriceBar[]): string {
  return 'timestamp,price\n' + bars.map((b) => `${new Date(b.t).toISOString()},${b.close.toFixed(4)}`).join('\n') + '\n';
}
