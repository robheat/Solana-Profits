// Append-only JSONL journal of snapshots and actions (local file, gitignored).
// The chain is the source of truth; the ledger adds history: P&L over time,
// multi-epoch yield estimates, and an audit trail of every signature sent.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface SnapshotEntry {
  type: 'snapshot';
  ts: string;
  epoch: string;
  wallet: string;
  solLamports: string;
  totalValueLamports: string;
  positions: { symbol: string; tokens: string; valueLamports: string; rate: number }[];
  /** Pool exchange rates observed (lamports per token as exact fraction). */
  rates: { symbol: string; epoch: string; totalLamports: string; poolTokenSupply: string }[];
}

export interface ActionEntry {
  type: 'action';
  ts: string;
  action: 'deposit' | 'withdraw';
  status: 'confirmed' | 'failed' | 'expired' | 'unknown';
  signature: string;
  wallet: string;
  pool: string;
  detail: Record<string, string>;
}

export type LedgerEntry = SnapshotEntry | ActionEntry;

export class Ledger {
  readonly path: string;
  constructor(path: string) {
    this.path = path;
  }

  append(entry: LedgerEntry): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    appendFileSync(this.path, JSON.stringify(entry) + '\n', { mode: 0o600 });
  }

  read(): LedgerEntry[] {
    if (!existsSync(this.path)) return [];
    const out: LedgerEntry[] = [];
    for (const line of readFileSync(this.path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as LedgerEntry);
      } catch {
        // A torn final line (e.g. crash mid-write) must not make history unreadable.
      }
    }
    return out;
  }

  snapshots(wallet: string): SnapshotEntry[] {
    return this.read().filter((e): e is SnapshotEntry => e.type === 'snapshot' && e.wallet === wallet);
  }
}

/**
 * Trailing yield of a pool from rates recorded in the ledger. Needs observations
 * at least `minEpochs` apart; more robust than the single-epoch on-chain estimate.
 */
export function trailingApy(
  snapshots: SnapshotEntry[],
  symbol: string,
  epochsPerYear: number,
  minEpochs = 3,
): { apy: number; epochs: number } | null {
  const obs = snapshots
    .flatMap((s) => s.rates.filter((r) => r.symbol === symbol))
    .map((r) => ({ epoch: BigInt(r.epoch), tl: BigInt(r.totalLamports), ps: BigInt(r.poolTokenSupply) }))
    .filter((r) => r.ps > 0n && r.tl > 0n)
    .sort((a, b) => (a.epoch < b.epoch ? -1 : a.epoch > b.epoch ? 1 : 0));
  const first = obs[0];
  const last = obs[obs.length - 1];
  if (!first || !last) return null;
  const epochs = Number(last.epoch - first.epoch);
  if (epochs < minEpochs) return null;
  const SCALE = 10n ** 18n;
  const growth = Number((last.tl * first.ps * SCALE) / (first.tl * last.ps)) / 1e18;
  return { apy: Math.pow(growth, epochsPerYear / epochs) - 1, epochs };
}
