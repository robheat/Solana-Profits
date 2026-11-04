// Jupiter swap API client (quote + swap transaction). The API only *proposes* a
// transaction; nothing it returns is trusted until the swap firewall and a
// simulation have checked it (src/bot/swap.ts).
//
//   JUPITER_API_URL  default https://lite-api.jup.ag (or https://api.jup.ag with a key)
//   JUPITER_API_KEY  optional, sent as x-api-key

import { toAddress, type Address } from '../crypto/keys.ts';
import { JsonClient, type HttpOptions } from '../util/http.ts';

export const WSOL_MINT = toAddress('So11111111111111111111111111111111111111112');
export const JUPITER_V6_PROGRAM_ID = toAddress('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
export const DEFAULT_JUPITER_URL = 'https://lite-api.jup.ag';

export interface Quote {
  inputMint: Address;
  outputMint: Address;
  inAmount: bigint;
  outAmount: bigint;
  /** Minimum output after slippage (what the program enforces for ExactIn). */
  otherAmountThreshold: bigint;
  slippageBps: number;
  priceImpactPct: number;
  hops: number;
  /** The untouched response, which must be passed back to /swap. */
  raw: Record<string, unknown>;
}

export interface SwapTransaction {
  transaction: Uint8Array;
  lastValidBlockHeight: bigint | null;
}

function intField(o: Record<string, unknown>, k: string): bigint {
  const v = o[k];
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  throw new Error(`Jupiter quote: field ${k} missing or not an integer`);
}

export function parseQuote(raw: unknown): Quote {
  if (!raw || typeof raw !== 'object') throw new Error('Jupiter quote: not an object');
  const o = raw as Record<string, unknown>;
  if (o.swapMode !== undefined && o.swapMode !== 'ExactIn') throw new Error(`Jupiter quote: unexpected swapMode ${String(o.swapMode)}`);
  const impact = Number(o.priceImpactPct ?? 0);
  if (!Number.isFinite(impact)) throw new Error('Jupiter quote: bad priceImpactPct');
  const plan = Array.isArray(o.routePlan) ? o.routePlan : [];
  const platformFee = o.platformFee as { amount?: string } | null | undefined;
  if (platformFee && platformFee.amount && platformFee.amount !== '0') throw new Error('Jupiter quote: unexpected platform fee');
  return {
    inputMint: toAddress(String(o.inputMint)),
    outputMint: toAddress(String(o.outputMint)),
    inAmount: intField(o, 'inAmount'),
    outAmount: intField(o, 'outAmount'),
    otherAmountThreshold: intField(o, 'otherAmountThreshold'),
    slippageBps: Number(o.slippageBps),
    // The API reports impact as a fraction string ("0.0123" = 1.23%).
    priceImpactPct: impact * 100,
    hops: plan.length,
    raw: o,
  };
}

export class JupiterClient {
  private readonly http: JsonClient;
  constructor(baseUrl = DEFAULT_JUPITER_URL, apiKey?: string, options: HttpOptions = {}) {
    this.http = new JsonClient(baseUrl, { ...options, headers: { ...(apiKey ? { 'x-api-key': apiKey } : {}), ...(options.headers ?? {}) } });
  }

  get host(): string {
    return this.http.host;
  }

  async quote(p: { inputMint: Address; outputMint: Address; amount: bigint; slippageBps: number }): Promise<Quote> {
    if (p.amount <= 0n) throw new Error('quote amount must be positive');
    const q = new URLSearchParams({
      inputMint: p.inputMint,
      outputMint: p.outputMint,
      amount: p.amount.toString(),
      slippageBps: String(p.slippageBps),
      swapMode: 'ExactIn',
      restrictIntermediateTokens: 'true',
      maxAccounts: '48',
    });
    const quote = parseQuote(await this.http.request('GET', `/swap/v1/quote?${q.toString()}`));
    if (quote.inputMint !== p.inputMint || quote.outputMint !== p.outputMint || quote.inAmount !== p.amount) {
      throw new Error('Jupiter quote does not match the request');
    }
    if (quote.slippageBps !== p.slippageBps) throw new Error('Jupiter quote changed the slippage');
    return quote;
  }

  async swapTransaction(quote: Quote, user: Address, maxPriorityFeeLamports: bigint): Promise<SwapTransaction> {
    const res = await this.http.request<Record<string, unknown>>('POST', '/swap/v1/swap', {
      quoteResponse: quote.raw,
      userPublicKey: user,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      dynamicSlippage: false,
      prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: Number(maxPriorityFeeLamports), priorityLevel: 'high' } },
    });
    const b64 = res.swapTransaction;
    if (typeof b64 !== 'string' || b64.length === 0) throw new Error('Jupiter swap: no transaction in response');
    const lvbh = res.lastValidBlockHeight;
    return {
      transaction: new Uint8Array(Buffer.from(b64, 'base64')),
      lastValidBlockHeight: typeof lvbh === 'number' && Number.isSafeInteger(lvbh) ? BigInt(lvbh) : null,
    };
  }
}
