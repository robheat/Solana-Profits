// Persistent bot state (atomic JSON file). The chain stays the source of truth for
// balances; this file remembers cost basis, peaks, cooldowns and history.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface PositionState {
  mint: string;
  symbol: string;
  decimals: number;
  tokenProgram: string;
  openedAt: number;
  /** SOL spent to open, including fees and token-account rent. */
  costLamports: string;
  tokens: string;
  realizedLamports: string;
  peakValueLamports: string;
  lastValueLamports: string;
  takeProfitDone: boolean;
}

export interface ClosedTrade {
  mint: string;
  symbol: string;
  openedAt: number;
  closedAt: number;
  costLamports: string;
  proceedsLamports: string;
  reason: string;
}

export interface PendingBuy {
  mint: string;
  symbol: string;
  decimals: number;
  tokenProgram: string;
  /** SOL committed to the buy (used as cost basis if a late landing is adopted). */
  lamports: string;
  at: number;
  signature: string | null;
}

export interface BotState {
  version: 1;
  mode: 'paper' | 'live';
  wallet: string;
  startedAt: number;
  startEquityLamports: string;
  /** Paper mode only: the simulated SOL balance. */
  paperSolLamports: string | null;
  lastScanAt: number;
  positions: PositionState[];
  closed: ClosedTrade[];
  /** mint -> epoch ms until which the mint is skipped. */
  cooldowns: Record<string, number>;
  rejects: Record<string, { until: number; reason: string }>;
  /** Write-ahead marker for an in-flight buy; blocks new buys until reconciled with the chain. */
  pendingBuy: PendingBuy | null;
}

export function newState(mode: 'paper' | 'live', wallet: string, equityLamports: bigint, nowMs: number, paperSol: bigint | null): BotState {
  return {
    version: 1,
    mode,
    wallet,
    startedAt: nowMs,
    startEquityLamports: equityLamports.toString(),
    paperSolLamports: paperSol === null ? null : paperSol.toString(),
    lastScanAt: 0,
    positions: [],
    closed: [],
    cooldowns: {},
    rejects: {},
    pendingBuy: null,
  };
}

export class StateStore {
  readonly path: string;
  constructor(path: string) {
    this.path = path;
  }
  exists(): boolean {
    return existsSync(this.path);
  }
  load(): BotState {
    const s = JSON.parse(readFileSync(this.path, 'utf8')) as BotState;
    if (s.version !== 1) throw new Error(`unsupported bot state version in ${this.path}`);
    return s;
  }
  save(state: BotState): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path); // atomic replace: a crash never leaves a torn state file
  }
}
