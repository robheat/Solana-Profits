// Strategy-router policy (config/router-policy.json): how market conditions are read,
// how strictly a regime change must be confirmed, and how each regime splits the wallet
// across strategies. Unknown keys are rejected.

import { toAddress, type Address } from '../crypto/keys.ts';
import { parseSol } from '../util/amount.ts';

export const REGIMES = ['risk-on', 'uptrend', 'range', 'downtrend', 'unknown'] as const;
export type RegimeName = (typeof REGIMES)[number];

/** Share of investable equity per strategy. Whatever is left stays as liquid SOL. */
export interface Weights {
  stake: number;
  hedge: number;
  momentum: number;
}

export interface RouterPolicy {
  profile: string;
  profiles: Record<string, Record<RegimeName, Weights>>;
  /** Enter a trend at bull/bearThresholdPct; leave it only when the gap shrinks below exitThresholdPct (hysteresis). */
  trend: { fastHours: number; slowHours: number; bullThresholdPct: number; bearThresholdPct: number; exitThresholdPct: number };
  volatility: { windowHours: number; highAnnualPct: number; momentumScaleWhenHigh: number };
  memeHeat: { topN: number; minBreadth: number; minPassing: number };
  switching: { confirmations: number; minDwellHours: number; evaluateMinutes: number };
  rebalance: { bandPct: number; minTradeLamports: bigint };
  feeReserveLamports: bigint;
  hedge: { mint: Address; symbol: string; decimals: number; slippageBps: number; maxPriceImpactPct: number };
  dataCheck: { maxPriceDisagreementPct: number; maxStalenessMinutes: number };
  momentumExitOnDisable: boolean;
  backtest: { stakingApyPct: number; swapFeeBps: number; stakeExitFeeBps: number; txFeeLamports: bigint };
}

type J = Record<string, unknown>;

function obj(v: unknown, path: string, keys: string[]): J {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${path} must be an object`);
  const o = v as J;
  for (const k of Object.keys(o)) if (k !== '$comment' && !keys.includes(k)) throw new Error(`unknown key "${k}" in ${path}`);
  for (const k of keys) if (!(k in o)) throw new Error(`${path}.${k} is required`);
  return o;
}

function num(o: J, k: string, path: string, min: number, max: number): number {
  const v = o[k];
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new Error(`${path}.${k} must be a number between ${min} and ${max}`);
  return v;
}

function sol(o: J, k: string, path: string): bigint {
  const v = o[k];
  if (typeof v !== 'string') throw new Error(`${path}.${k} must be a decimal string of SOL`);
  return parseSol(v);
}

function weights(v: unknown, path: string): Weights {
  const o = obj(v, path, ['stake', 'hedge', 'momentum']);
  const w = { stake: num(o, 'stake', path, 0, 1), hedge: num(o, 'hedge', path, 0, 1), momentum: num(o, 'momentum', path, 0, 1) };
  if (w.stake + w.hedge + w.momentum > 1 + 1e-9) throw new Error(`${path}: weights add up to more than 1`);
  return w;
}

export function parseRouterPolicy(raw: unknown): RouterPolicy {
  const o = obj(raw, 'router-policy', [
    'profile', 'profiles', 'trend', 'volatility', 'memeHeat', 'switching', 'rebalance', 'feeReserveSol', 'hedge', 'dataCheck', 'momentumExitOnDisable', 'backtest',
  ]);
  const profilesRaw = o.profiles;
  if (!profilesRaw || typeof profilesRaw !== 'object') throw new Error('router-policy.profiles must be an object');
  const profiles: Record<string, Record<RegimeName, Weights>> = {};
  for (const [name, table] of Object.entries(profilesRaw as J)) {
    if (name === '$comment') continue;
    const t = obj(table, `profiles.${name}`, [...REGIMES]);
    profiles[name] = Object.fromEntries(REGIMES.map((r) => [r, weights(t[r], `profiles.${name}.${r}`)])) as Record<RegimeName, Weights>;
  }
  const profile = String(o.profile);
  if (!profiles[profile]) throw new Error(`router-policy.profile "${profile}" is not one of: ${Object.keys(profiles).join(', ')}`);

  const tr = obj(o.trend, 'trend', ['fastHours', 'slowHours', 'bullThresholdPct', 'bearThresholdPct', 'exitThresholdPct']);
  const trend = {
    fastHours: num(tr, 'fastHours', 'trend', 2, 24 * 30),
    slowHours: num(tr, 'slowHours', 'trend', 4, 24 * 120),
    bullThresholdPct: num(tr, 'bullThresholdPct', 'trend', 0, 50),
    bearThresholdPct: num(tr, 'bearThresholdPct', 'trend', 0, 50),
    exitThresholdPct: num(tr, 'exitThresholdPct', 'trend', 0, 50),
  };
  if (trend.exitThresholdPct > Math.min(trend.bullThresholdPct, trend.bearThresholdPct)) throw new Error('trend.exitThresholdPct must not exceed the entry thresholds');
  if (trend.fastHours >= trend.slowHours) throw new Error('trend.fastHours must be shorter than trend.slowHours');
  const vo = obj(o.volatility, 'volatility', ['windowHours', 'highAnnualPct', 'momentumScaleWhenHigh']);
  const mh = obj(o.memeHeat, 'memeHeat', ['topN', 'minBreadth', 'minPassing']);
  const sw = obj(o.switching, 'switching', ['confirmations', 'minDwellHours', 'evaluateMinutes']);
  const rb = obj(o.rebalance, 'rebalance', ['bandPct', 'minTradeSol']);
  const hd = obj(o.hedge, 'hedge', ['mint', 'symbol', 'decimals', 'slippageBps', 'maxPriceImpactPct']);
  const dc = obj(o.dataCheck, 'dataCheck', ['maxPriceDisagreementPct', 'maxStalenessMinutes']);
  const bt = obj(o.backtest, 'backtest', ['stakingApyPct', 'swapFeeBps', 'stakeExitFeeBps', 'txFeeSol']);
  if (typeof o.momentumExitOnDisable !== 'boolean') throw new Error('router-policy.momentumExitOnDisable must be boolean');

  const policy: RouterPolicy = {
    profile,
    profiles,
    trend,
    volatility: {
      windowHours: num(vo, 'windowHours', 'volatility', 24, 24 * 90),
      highAnnualPct: num(vo, 'highAnnualPct', 'volatility', 10, 1_000),
      momentumScaleWhenHigh: num(vo, 'momentumScaleWhenHigh', 'volatility', 0, 1),
    },
    memeHeat: { topN: num(mh, 'topN', 'memeHeat', 5, 100), minBreadth: num(mh, 'minBreadth', 'memeHeat', 0, 1), minPassing: num(mh, 'minPassing', 'memeHeat', 0, 100) },
    switching: {
      confirmations: num(sw, 'confirmations', 'switching', 1, 48),
      minDwellHours: num(sw, 'minDwellHours', 'switching', 0, 24 * 30),
      evaluateMinutes: num(sw, 'evaluateMinutes', 'switching', 5, 24 * 60),
    },
    rebalance: { bandPct: num(rb, 'bandPct', 'rebalance', 0, 50), minTradeLamports: sol(rb, 'minTradeSol', 'rebalance') },
    feeReserveLamports: sol(o, 'feeReserveSol', 'router-policy'),
    hedge: {
      mint: toAddress(String(hd.mint)),
      symbol: String(hd.symbol),
      decimals: num(hd, 'decimals', 'hedge', 0, 12),
      slippageBps: num(hd, 'slippageBps', 'hedge', 1, 500),
      maxPriceImpactPct: num(hd, 'maxPriceImpactPct', 'hedge', 0.01, 10),
    },
    dataCheck: {
      maxPriceDisagreementPct: num(dc, 'maxPriceDisagreementPct', 'dataCheck', 0.1, 20),
      maxStalenessMinutes: num(dc, 'maxStalenessMinutes', 'dataCheck', 5, 24 * 60),
    },
    momentumExitOnDisable: o.momentumExitOnDisable,
    backtest: {
      stakingApyPct: num(bt, 'stakingApyPct', 'backtest', 0, 50),
      swapFeeBps: num(bt, 'swapFeeBps', 'backtest', 0, 500),
      stakeExitFeeBps: num(bt, 'stakeExitFeeBps', 'backtest', 0, 500),
      txFeeLamports: sol(bt, 'txFeeSol', 'backtest'),
    },
  };
  if (policy.feeReserveLamports < 20_000_000n) throw new Error('router-policy.feeReserveSol must be at least 0.02 SOL (exits from every strategy must stay affordable)');
  if (!Number.isInteger(policy.switching.confirmations)) throw new Error('switching.confirmations must be an integer');
  return policy;
}
