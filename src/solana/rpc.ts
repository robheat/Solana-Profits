// Minimal JSON-RPC client for the handful of Solana RPC methods this tool uses.
// Uses Node's built-in fetch: no HTTP dependency to audit.

import { toAddress, type Address } from '../crypto/keys.ts';
import { fromBase64 } from '../util/bytes.ts';

export class RpcError extends Error {
  readonly code: number | undefined;
  readonly data: unknown;
  constructor(message: string, code?: number, data?: unknown) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
}

export interface AccountInfo {
  lamports: bigint;
  owner: Address;
  executable: boolean;
  data: Uint8Array;
}

export interface SimulationResult {
  err: unknown;
  logs: string[];
  unitsConsumed: number | undefined;
  accounts: (AccountInfo | null)[];
}

export interface SignatureStatus {
  slot: number;
  confirmations: number | null;
  err: unknown;
  confirmationStatus: 'processed' | 'confirmed' | 'finalized' | null;
}

export type Commitment = 'processed' | 'confirmed' | 'finalized';

export interface RpcOptions {
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  /** Called before each retry; used by tests to avoid real sleeps. */
  sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE_HTTP = new Set([429, 500, 502, 503, 504]);

/** JSON.parse that keeps integers above 2^53 exact (as bigint) using the reviver source text. */
function parseJsonExact(text: string): unknown {
  return JSON.parse(text, (_key: string, value: unknown, context?: { source?: string }) => {
    if (typeof value === 'number' && !Number.isSafeInteger(value) && Number.isInteger(value) && context?.source) {
      return BigInt(context.source);
    }
    return value;
  });
}

export function toBigInt(value: unknown, what: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  throw new RpcError(`RPC returned a non-integer ${what}: ${String(value)}`);
}

function parseAccount(raw: unknown): AccountInfo | null {
  if (raw === null || raw === undefined) return null;
  const r = raw as { lamports: unknown; owner: string; executable: boolean; data: [string, string] | unknown };
  if (!Array.isArray(r.data) || r.data[1] !== 'base64') throw new RpcError('expected base64 account data');
  return {
    lamports: toBigInt(r.lamports, 'lamports'),
    owner: toAddress(r.owner),
    executable: Boolean(r.executable),
    data: fromBase64(String(r.data[0])),
  };
}

export class Rpc {
  readonly url: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private nextId = 1;

  constructor(url: string, options: RpcOptions = {}) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
      throw new Error('RPC URL must use https (plain http is only allowed for localhost)');
    }
    this.url = url;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.maxRetries = options.maxRetries ?? 4;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Host only, for display: RPC URLs often embed API keys in the path or query. */
  get displayUrl(): string {
    const u = new URL(this.url);
    return `${u.protocol}//${u.host}`;
  }

  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const body = JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params });
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await this.sleep(Math.min(8000, 500 * 2 ** (attempt - 1)));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let res: Response;
      try {
        res = await this.fetchImpl(this.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal: controller.signal,
        });
      } catch (e) {
        lastError = e;
        continue; // network error or timeout: retry
      } finally {
        clearTimeout(timer);
      }
      if (RETRYABLE_HTTP.has(res.status)) {
        lastError = new RpcError(`RPC HTTP ${res.status} for ${method}`);
        continue;
      }
      if (!res.ok) throw new RpcError(`RPC HTTP ${res.status} for ${method}`);
      const json = parseJsonExact(await res.text()) as {
        result?: T;
        error?: { code: number; message: string; data?: unknown };
      };
      if (json.error) throw new RpcError(`${method}: ${json.error.message}`, json.error.code, json.error.data);
      if (!('result' in json)) throw new RpcError(`${method}: malformed RPC response`);
      return json.result as T;
    }
    let detail = lastError instanceof Error ? lastError.message : String(lastError);
    const cause = lastError instanceof Error ? (lastError.cause as { message?: string; code?: string } | undefined) : undefined;
    if (cause && (cause.message || cause.code)) detail += ` (${cause.message ?? cause.code})`;
    throw new RpcError(`${method} failed after ${this.maxRetries + 1} attempts via ${this.displayUrl}: ${detail}`);
  }

  getGenesisHash(): Promise<string> {
    return this.call<string>('getGenesisHash');
  }

  async getEpochInfo(commitment: Commitment = 'confirmed'): Promise<{
    epoch: bigint;
    slotIndex: bigint;
    slotsInEpoch: bigint;
    absoluteSlot: bigint;
    blockHeight: bigint;
  }> {
    const r = await this.call<Record<string, unknown>>('getEpochInfo', [{ commitment }]);
    return {
      epoch: toBigInt(r.epoch, 'epoch'),
      slotIndex: toBigInt(r.slotIndex, 'slotIndex'),
      slotsInEpoch: toBigInt(r.slotsInEpoch, 'slotsInEpoch'),
      absoluteSlot: toBigInt(r.absoluteSlot, 'absoluteSlot'),
      blockHeight: toBigInt(r.blockHeight, 'blockHeight'),
    };
  }

  async getAccountInfo(address: Address, commitment: Commitment = 'confirmed'): Promise<AccountInfo | null> {
    const r = await this.call<{ value: unknown }>('getAccountInfo', [address, { encoding: 'base64', commitment }]);
    return parseAccount(r.value);
  }

  async getMultipleAccounts(addresses: Address[], commitment: Commitment = 'confirmed'): Promise<(AccountInfo | null)[]> {
    const out: (AccountInfo | null)[] = [];
    for (let i = 0; i < addresses.length; i += 100) {
      const chunk = addresses.slice(i, i + 100);
      const r = await this.call<{ value: unknown[] }>('getMultipleAccounts', [chunk, { encoding: 'base64', commitment }]);
      if (!Array.isArray(r.value) || r.value.length !== chunk.length) throw new RpcError('getMultipleAccounts: bad response');
      out.push(...r.value.map(parseAccount));
    }
    return out;
  }

  async getBalance(address: Address, commitment: Commitment = 'confirmed'): Promise<bigint> {
    const r = await this.call<{ value: unknown }>('getBalance', [address, { commitment }]);
    return toBigInt(r.value, 'balance');
  }

  async getLatestBlockhash(commitment: Commitment = 'confirmed'): Promise<{ blockhash: string; lastValidBlockHeight: bigint }> {
    const r = await this.call<{ value: { blockhash: string; lastValidBlockHeight: unknown } }>('getLatestBlockhash', [
      { commitment },
    ]);
    return { blockhash: r.value.blockhash, lastValidBlockHeight: toBigInt(r.value.lastValidBlockHeight, 'lastValidBlockHeight') };
  }

  async getBlockHeight(commitment: Commitment = 'confirmed'): Promise<bigint> {
    return toBigInt(await this.call<unknown>('getBlockHeight', [{ commitment }]), 'blockHeight');
  }

  async getMinimumBalanceForRentExemption(size: number): Promise<bigint> {
    return toBigInt(await this.call<unknown>('getMinimumBalanceForRentExemption', [size]), 'rent');
  }

  async getRecentPrioritizationFees(addresses: Address[]): Promise<bigint[]> {
    const r = await this.call<{ slot: number; prioritizationFee: unknown }[]>('getRecentPrioritizationFees', [addresses]);
    return r.map((x) => toBigInt(x.prioritizationFee, 'prioritizationFee'));
  }

  async getRecentPerformanceSamples(limit = 60): Promise<{ numSlots: number; samplePeriodSecs: number }[]> {
    return this.call('getRecentPerformanceSamples', [limit]);
  }

  async getEpochSchedule(): Promise<{ slotsPerEpoch: bigint }> {
    const r = await this.call<Record<string, unknown>>('getEpochSchedule');
    return { slotsPerEpoch: toBigInt(r.slotsPerEpoch, 'slotsPerEpoch') };
  }

  async simulateTransaction(txBase64: string, accountAddresses: Address[]): Promise<SimulationResult> {
    const r = await this.call<{
      value: { err: unknown; logs: string[] | null; unitsConsumed?: number; accounts?: unknown[] | null };
    }>('simulateTransaction', [
      txBase64,
      {
        encoding: 'base64',
        commitment: 'confirmed',
        sigVerify: false,
        replaceRecentBlockhash: true,
        accounts: { encoding: 'base64', addresses: accountAddresses },
      },
    ]);
    const v = r.value;
    return {
      err: v.err ?? null,
      logs: v.logs ?? [],
      unitsConsumed: v.unitsConsumed,
      accounts: (v.accounts ?? []).map(parseAccount),
    };
  }

  sendTransaction(txBase64: string): Promise<string> {
    return this.call<string>('sendTransaction', [
      txBase64,
      { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0 },
    ]);
  }

  async getSignatureStatus(signature: string): Promise<SignatureStatus | null> {
    const r = await this.call<{ value: (SignatureStatus | null)[] }>('getSignatureStatuses', [
      [signature],
      { searchTransactionHistory: true },
    ]);
    return r.value[0] ?? null;
  }
}
