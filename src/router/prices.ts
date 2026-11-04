// SOL/USD price history for regime detection and backtests.
//   * Pyth Benchmarks (TradingView-style history endpoint backed by the Pyth oracle),
//     https://benchmarks.pyth.network, no key needed.
//   * A CSV file of `timestamp,price` (ISO time or unix seconds/ms), for offline backtests.
// Live decisions also cross-check the latest close against an executable Jupiter quote.

import { JsonClient, type HttpOptions } from '../util/http.ts';

export interface PriceBar {
  /** Bar time, ms since epoch. */
  t: number;
  close: number;
}

export const DEFAULT_PYTH_URL = 'https://benchmarks.pyth.network';
export const SOL_USD_SYMBOL = 'Crypto.SOL/USD';

/** Sorted, one bar per hour (last value wins), only positive finite prices. */
export function cleanBars(bars: PriceBar[]): PriceBar[] {
  const byHour = new Map<number, PriceBar>();
  for (const b of bars) {
    if (!Number.isFinite(b.t) || !Number.isFinite(b.close) || b.close <= 0) continue;
    const hour = Math.floor(b.t / 3_600_000) * 3_600_000;
    byHour.set(hour, { t: hour, close: b.close });
  }
  return [...byHour.values()].sort((a, b) => a.t - b.t);
}

export function parsePythHistory(raw: unknown): PriceBar[] {
  if (!raw || typeof raw !== 'object') throw new Error('price history: not an object');
  const o = raw as { s?: string; t?: unknown; c?: unknown; errmsg?: string };
  if (o.s === 'no_data') return [];
  if (o.s !== 'ok') throw new Error(`price history: status ${String(o.s)}${o.errmsg ? ` (${o.errmsg})` : ''}`);
  if (!Array.isArray(o.t) || !Array.isArray(o.c) || o.t.length !== o.c.length) throw new Error('price history: malformed t/c arrays');
  return o.t.map((t, i) => ({ t: Number(t) * 1000, close: Number((o.c as unknown[])[i]) }));
}

export class PythBenchmarks {
  private readonly http: JsonClient;
  constructor(baseUrl = DEFAULT_PYTH_URL, opts: HttpOptions = {}) {
    this.http = new JsonClient(baseUrl, opts);
  }
  get host(): string {
    return this.http.host;
  }
  /** Hourly closes between `fromMs` and `toMs`, fetched in 30-day chunks. */
  async hourly(fromMs: number, toMs: number, symbol = SOL_USD_SYMBOL): Promise<PriceBar[]> {
    const chunk = 30 * 86_400_000;
    const out: PriceBar[] = [];
    for (let from = fromMs; from < toMs; from += chunk) {
      const to = Math.min(toMs, from + chunk);
      const q = new URLSearchParams({ symbol, resolution: '60', from: String(Math.floor(from / 1000)), to: String(Math.floor(to / 1000)) });
      out.push(...parsePythHistory(await this.http.request('GET', `/v1/shims/tradingview/history?${q.toString()}`)));
    }
    return cleanBars(out);
  }
}

export function parsePriceCsv(text: string): PriceBar[] {
  const bars: PriceBar[] = [];
  for (const [n, line] of text.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [ts, px] = trimmed.split(/[,;\t]/).map((x) => x.trim());
    if (ts === undefined || px === undefined) continue;
    const price = Number(px);
    if (!Number.isFinite(price)) {
      if (n === 0) continue; // header row
      throw new Error(`price CSV line ${n + 1}: bad price "${px}"`);
    }
    let t: number;
    if (/^\d+(\.\d+)?$/.test(ts)) {
      const v = Number(ts);
      t = v < 1e12 ? v * 1000 : v; // unix seconds or ms
    } else {
      t = Date.parse(ts);
    }
    if (!Number.isFinite(t)) throw new Error(`price CSV line ${n + 1}: bad timestamp "${ts}"`);
    bars.push({ t, close: price });
  }
  return cleanBars(bars);
}
