// Plain indicator math over hourly closes. No look-ahead: value i only uses inputs 0..i.

/** Exponential moving average seeded with the simple average of the first `period` values. NaN before that. */
export function ema(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(Number.NaN);
  if (period < 1 || values.length < period) return out;
  const alpha = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i] as number;
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = alpha * (values[i] as number) + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

export function sma(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(Number.NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i] as number;
    if (i >= period) sum -= values[i - period] as number;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function logReturns(values: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < values.length; i++) out.push(Math.log((values[i] as number) / (values[i - 1] as number)));
  return out;
}

export function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const v = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(v);
}

/** Annualized realized volatility (%) of hourly closes over the last `windowHours`. */
export function realizedVolAnnualPct(hourlyCloses: number[], windowHours: number): number {
  const window = hourlyCloses.slice(-(windowHours + 1));
  return stdev(logReturns(window)) * Math.sqrt(24 * 365) * 100;
}
