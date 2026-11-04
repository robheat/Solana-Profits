// Bot risk policy, loaded from config/bot-policy.json. Unknown keys are rejected.

import { parseSol } from '../util/amount.ts';

export interface Filters {
  minLiquidityUsd: number;
  minMarketCapUsd: number;
  maxMarketCapUsd: number;
  minHolderCount: number;
  maxTopHoldersPct: number;
  maxDevBalancePct: number;
  minOrganicScore: number;
  minAgeHours: number;
  maxAgeDays: number;
  min1hPriceChangePct: number;
  max1hPriceChangePct: number;
  min5mPriceChangePct: number;
  minBuySellRatio1h: number;
  min1hVolumeUsd: number;
}

export interface BotPolicy {
  /** SOL never used for positions: pays for exits and account rent. */
  feeReserveLamports: bigint;
  maxOpenPositions: number;
  /** Share of total equity committed to each new position. */
  positionFraction: number;
  minPositionLamports: bigint;
  /** Sell `takeProfitSellFraction` of a position once it is up this much. */
  takeProfitPct: number;
  takeProfitSellFraction: number;
  /** After the take-profit, exit the rest if it falls this far from its peak. */
  trailingStopPct: number;
  /** Exit everything if a position is down this much (before any take-profit). */
  stopLossPct: number;
  maxHoldHours: number;
  /** Stop opening positions when total equity falls below this. */
  equityFloorLamports: bigint;
  cooldownHours: number;
  buySlippageBps: number;
  sellSlippageBps: number;
  /** Slippage allowed when a stop must be executed no matter what. */
  emergencySlippageBps: number;
  maxPriceImpactPct: number;
  maxRoundTripLossPct: number;
  maxPriorityFeeLamports: bigint;
  scanIntervalSeconds: number;
  tickIntervalSeconds: number;
  filters: Filters;
}

const TOP = new Set([
  '$comment', 'feeReserveSol', 'maxOpenPositions', 'positionFraction', 'minPositionSol', 'takeProfitPct', 'takeProfitSellFraction',
  'trailingStopPct', 'stopLossPct', 'maxHoldHours', 'equityFloorSol', 'cooldownHours', 'buySlippageBps', 'sellSlippageBps',
  'emergencySlippageBps', 'maxPriceImpactPct', 'maxRoundTripLossPct', 'maxPriorityFeeSol', 'scanIntervalSeconds', 'tickIntervalSeconds', 'filters',
]);
const FILTER_KEYS: (keyof Filters)[] = [
  'minLiquidityUsd', 'minMarketCapUsd', 'maxMarketCapUsd', 'minHolderCount', 'maxTopHoldersPct', 'maxDevBalancePct', 'minOrganicScore',
  'minAgeHours', 'maxAgeDays', 'min1hPriceChangePct', 'max1hPriceChangePct', 'min5mPriceChangePct', 'minBuySellRatio1h', 'min1hVolumeUsd',
];

type J = Record<string, unknown>;

function n(o: J, k: string, min: number, max: number, path = 'bot-policy'): number {
  const v = o[k];
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new Error(`${path}.${k} must be a number between ${min} and ${max}`);
  return v;
}
function int(o: J, k: string, min: number, max: number): number {
  const v = n(o, k, min, max);
  if (!Number.isInteger(v)) throw new Error(`bot-policy.${k} must be an integer`);
  return v;
}
function sol(o: J, k: string): bigint {
  const v = o[k];
  if (typeof v !== 'string') throw new Error(`bot-policy.${k} must be a decimal string of SOL`);
  return parseSol(v);
}

export function parseBotPolicy(raw: unknown): BotPolicy {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('bot policy must be a JSON object');
  const o = raw as J;
  for (const k of Object.keys(o)) if (!TOP.has(k)) throw new Error(`unknown bot-policy key "${k}"`);
  for (const k of TOP) if (k !== '$comment' && !(k in o)) throw new Error(`bot-policy.${k} is required`);
  const f = o.filters as J;
  if (!f || typeof f !== 'object') throw new Error('bot-policy.filters must be an object');
  for (const k of Object.keys(f)) if (!(FILTER_KEYS as string[]).includes(k)) throw new Error(`unknown bot-policy.filters key "${k}"`);
  const filters = Object.fromEntries(FILTER_KEYS.map((k) => [k, n(f, k, -1e12, 1e12, 'bot-policy.filters')])) as unknown as Filters;

  const p: BotPolicy = {
    feeReserveLamports: sol(o, 'feeReserveSol'),
    maxOpenPositions: int(o, 'maxOpenPositions', 1, 10),
    positionFraction: n(o, 'positionFraction', 0.01, 1),
    minPositionLamports: sol(o, 'minPositionSol'),
    takeProfitPct: n(o, 'takeProfitPct', 5, 10_000),
    takeProfitSellFraction: n(o, 'takeProfitSellFraction', 0.1, 1),
    trailingStopPct: n(o, 'trailingStopPct', 1, 95),
    stopLossPct: n(o, 'stopLossPct', 1, 95),
    maxHoldHours: n(o, 'maxHoldHours', 0.1, 24 * 30),
    equityFloorLamports: sol(o, 'equityFloorSol'),
    cooldownHours: n(o, 'cooldownHours', 0, 24 * 30),
    buySlippageBps: int(o, 'buySlippageBps', 1, 1_000),
    sellSlippageBps: int(o, 'sellSlippageBps', 1, 2_000),
    emergencySlippageBps: int(o, 'emergencySlippageBps', 1, 3_000),
    maxPriceImpactPct: n(o, 'maxPriceImpactPct', 0.01, 20),
    maxRoundTripLossPct: n(o, 'maxRoundTripLossPct', 0.1, 30),
    maxPriorityFeeLamports: sol(o, 'maxPriorityFeeSol'),
    scanIntervalSeconds: n(o, 'scanIntervalSeconds', 10, 3_600),
    tickIntervalSeconds: n(o, 'tickIntervalSeconds', 5, 600),
    filters,
  };
  if (p.feeReserveLamports < 10_000_000n) throw new Error('bot-policy.feeReserveSol must be at least 0.01 SOL so exits can always be paid for');
  if (p.maxPriorityFeeLamports > 5_000_000n) throw new Error('bot-policy.maxPriorityFeeSol above 0.005 SOL is not allowed');
  if (p.emergencySlippageBps < p.sellSlippageBps) throw new Error('bot-policy.emergencySlippageBps must be >= sellSlippageBps');
  return p;
}
