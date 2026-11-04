// Token discovery from the Jupiter Tokens API (v2): trending tokens with market
// stats and audit flags. Treated as untrusted input: every field is validated,
// malformed entries are dropped, and anything security-relevant (mint / freeze
// authority, token program) is re-checked on-chain before a buy.

import { toAddress, type Address } from '../crypto/keys.ts';
import { JsonClient, type HttpOptions } from '../util/http.ts';
import { DEFAULT_JUPITER_URL } from './jupiter.ts';

export interface WindowStats {
  priceChangePct: number | null;
  buyVolumeUsd: number | null;
  sellVolumeUsd: number | null;
  numBuys: number | null;
  numSells: number | null;
}

export interface TokenInfo {
  mint: Address;
  symbol: string;
  name: string;
  decimals: number;
  usdPrice: number | null;
  liquidityUsd: number | null;
  mcapUsd: number | null;
  holderCount: number | null;
  organicScore: number | null;
  isVerified: boolean;
  /** Creation time of the token's first pool, ms since epoch. */
  firstPoolAt: number | null;
  topHoldersPct: number | null;
  devBalancePct: number | null;
  /** Feed's view of authorities (re-verified on-chain). */
  mintAuthorityDisabled: boolean | null;
  freezeAuthorityDisabled: boolean | null;
  stats5m: WindowStats;
  stats1h: WindowStats;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

function stats(v: unknown): WindowStats {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return {
    priceChangePct: num(o.priceChange),
    buyVolumeUsd: num(o.buyVolume),
    sellVolumeUsd: num(o.sellVolume),
    numBuys: num(o.numBuys),
    numSells: num(o.numSells),
  };
}

export function parseToken(raw: unknown): TokenInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  let mint: Address;
  try {
    mint = toAddress(String(o.id ?? o.address ?? ''));
  } catch {
    return null;
  }
  const decimals = num(o.decimals);
  if (decimals === null || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) return null;
  const audit = (o.audit && typeof o.audit === 'object' ? o.audit : {}) as Record<string, unknown>;
  const firstPool = (o.firstPool && typeof o.firstPool === 'object' ? o.firstPool : {}) as Record<string, unknown>;
  const created = typeof firstPool.createdAt === 'string' ? Date.parse(firstPool.createdAt) : num(firstPool.createdAt);
  return {
    mint,
    symbol: String(o.symbol ?? '?').slice(0, 16).replace(/[^\x20-\x7e]/g, '?'),
    name: String(o.name ?? '').slice(0, 48).replace(/[^\x20-\x7e]/g, '?'),
    decimals,
    usdPrice: num(o.usdPrice),
    liquidityUsd: num(o.liquidity),
    mcapUsd: num(o.mcap),
    holderCount: num(o.holderCount),
    organicScore: num(o.organicScore),
    isVerified: o.isVerified === true,
    firstPoolAt: created !== null && Number.isFinite(created) ? created : null,
    topHoldersPct: num(audit.topHoldersPercentage),
    devBalancePct: num(audit.devBalancePercentage),
    mintAuthorityDisabled: bool(audit.mintAuthorityDisabled),
    freezeAuthorityDisabled: bool(audit.freezeAuthorityDisabled),
    stats5m: stats(o.stats5m),
    stats1h: stats(o.stats1h),
  };
}

export interface TokenFeed {
  trending(): Promise<TokenInfo[]>;
}

export class JupiterTokenFeed implements TokenFeed {
  private readonly http: JsonClient;
  private readonly category: string;
  private readonly interval: string;
  constructor(baseUrl = DEFAULT_JUPITER_URL, apiKey?: string, opts: { category?: string; interval?: string; http?: HttpOptions } = {}) {
    this.http = new JsonClient(baseUrl, { ...opts.http, headers: apiKey ? { 'x-api-key': apiKey } : {} });
    this.category = opts.category ?? 'toptrending';
    this.interval = opts.interval ?? '1h';
  }

  async trending(): Promise<TokenInfo[]> {
    const res = await this.http.request<unknown>('GET', `/tokens/v2/${this.category}/${this.interval}?limit=100`);
    if (!Array.isArray(res)) throw new Error('token feed: expected an array');
    const out: TokenInfo[] = [];
    const seen = new Set<string>();
    for (const r of res) {
      const t = parseToken(r);
      if (t && !seen.has(t.mint)) {
        seen.add(t.mint);
        out.push(t);
      }
    }
    return out;
  }
}
