// The trading loop. One tick = value every position and apply exits, then (at the
// scan interval) look for at most one new entry. State is saved after every action.
// Live buys are bracketed by a write-ahead `pendingBuy` marker so a crash or an
// unconfirmed transaction can never cause a duplicate buy or a forgotten position.

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Address } from '../crypto/keys.ts';
import { decodeTokenAccount } from '../solana/accounts.ts';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../solana/constants.ts';
import type { Rpc } from '../solana/rpc.ts';
import { formatSol, formatUnits } from '../util/amount.ts';
import type { TokenFeed, TokenInfo } from './feed.ts';
import { WSOL_MINT, type Quote } from './jupiter.ts';
import type { BotPolicy } from './policy.ts';
import { checkMintAccount } from './safety.ts';
import { decideExit, positionSize, rankCandidates, ESTIMATED_TX_FEE_LAMPORTS } from './strategy.ts';
import { closeEmptyTokenAccount, executeSwap, SwapRejected, type SwapContext } from './swap.ts';
import type { BotState, PositionState, StateStore } from './state.ts';
import { newState } from './state.ts';

export interface Market {
  quote(p: { inputMint: Address; outputMint: Address; amount: bigint; slippageBps: number }): Promise<Quote>;
}

export interface Candidate extends TokenInfo {
  tokenProgram: Address;
}

export interface BuyFill {
  tokens: bigint;
  costLamports: bigint;
  signature: string | null;
}

export interface SellFill {
  tokensSold: bigint;
  proceedsLamports: bigint;
  signature: string | null;
}

export interface Broker {
  readonly mode: 'paper' | 'live';
  solBalance(state: BotState): Promise<bigint>;
  buy(c: Candidate, lamports: bigint, quote: Quote, state: BotState): Promise<BuyFill | null>;
  sell(p: PositionState, tokens: bigint, slippageBps: number, state: BotState): Promise<SellFill | null>;
  reconcile(state: BotState, nowMs: number): Promise<string[]>;
}

export class EventLog {
  readonly path: string;
  constructor(path: string) {
    this.path = path;
  }
  append(e: Record<string, unknown>): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    appendFileSync(this.path, JSON.stringify({ ts: new Date().toISOString(), ...e }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) + '\n', { mode: 0o600 });
  }
}

const paperFee = (policy: BotPolicy) => ESTIMATED_TX_FEE_LAMPORTS + policy.maxPriorityFeeLamports / 2n;

/** Simulated fills at the quoted price. An optimistic upper bound: real fills also suffer MEV, failed transactions and latency. */
export class PaperBroker implements Broker {
  readonly mode = 'paper' as const;
  private readonly market: Market;
  private readonly policy: BotPolicy;
  private readonly rent: bigint;
  constructor(market: Market, policy: BotPolicy, rentTokenAccount: bigint) {
    this.market = market;
    this.policy = policy;
    this.rent = rentTokenAccount;
  }
  async solBalance(state: BotState): Promise<bigint> {
    return BigInt(state.paperSolLamports ?? '0');
  }
  async buy(_c: Candidate, lamports: bigint, quote: Quote, state: BotState): Promise<BuyFill | null> {
    const cost = lamports + paperFee(this.policy) + this.rent;
    const sol = BigInt(state.paperSolLamports ?? '0');
    if (cost > sol) return null;
    state.paperSolLamports = (sol - cost).toString();
    return { tokens: quote.outAmount, costLamports: cost, signature: null };
  }
  async sell(p: PositionState, tokens: bigint, slippageBps: number, state: BotState): Promise<SellFill | null> {
    const q = await this.market.quote({ inputMint: p.mint as Address, outputMint: WSOL_MINT, amount: tokens, slippageBps });
    const closing = tokens === BigInt(p.tokens);
    const proceeds = q.outAmount - paperFee(this.policy) + (closing ? this.rent : 0n);
    state.paperSolLamports = (BigInt(state.paperSolLamports ?? '0') + proceeds).toString();
    return { tokensSold: tokens, proceedsLamports: proceeds, signature: null };
  }
  async reconcile(): Promise<string[]> {
    return [];
  }
}

/** Real swaps through the firewall-guarded executor. */
export class LiveBroker implements Broker {
  readonly mode = 'live' as const;
  private readonly ctx: SwapContext;
  private readonly policy: BotPolicy;
  constructor(ctx: SwapContext, policy: BotPolicy) {
    this.ctx = ctx;
    this.policy = policy;
  }
  async solBalance(): Promise<bigint> {
    return this.ctx.rpc.getBalance(this.ctx.wallet);
  }
  async buy(c: Candidate, lamports: bigint, _quote: Quote, state: BotState): Promise<BuyFill | null> {
    const r = await executeSwap(this.ctx, {
      inputMint: WSOL_MINT,
      outputMint: c.mint,
      inputTokenProgram: TOKEN_PROGRAM_ID,
      outputTokenProgram: c.tokenProgram,
      amount: lamports,
      slippageBps: this.policy.buySlippageBps,
      maxPriceImpactPct: this.policy.maxPriceImpactPct,
    });
    if (r.status === 'confirmed' && r.tokenDelta > 0n) return { tokens: r.tokenDelta, costLamports: -r.solDelta, signature: r.signature };
    if (r.status === 'unknown' || r.status === 'confirmed') {
      // Outcome not established: keep the write-ahead marker so reconciliation decides.
      if (state.pendingBuy) state.pendingBuy.signature = r.signature;
      this.ctx.log(`buy ${c.symbol}: outcome unknown (${r.signature}); new buys paused until reconciled`);
    } else {
      // failed / expired: the transaction can never land, nothing to reconcile.
      this.ctx.log(`buy ${c.symbol}: ${r.status}${r.error ? ` (${r.error})` : ''}`);
    }
    return null;
  }
  async sell(p: PositionState, tokens: bigint, slippageBps: number): Promise<SellFill | null> {
    const r = await executeSwap(this.ctx, {
      inputMint: p.mint as Address,
      outputMint: WSOL_MINT,
      inputTokenProgram: p.tokenProgram as Address,
      outputTokenProgram: TOKEN_PROGRAM_ID,
      amount: tokens,
      slippageBps,
      // Exits must not be blocked by price impact; slippage still bounds the price.
      maxPriceImpactPct: 100,
    });
    if (r.status !== 'confirmed') {
      this.ctx.log(`sell ${p.symbol}: ${r.status}${r.error ? ` (${r.error})` : ''}`);
      return null;
    }
    let proceeds = r.solDelta;
    if (tokens === BigInt(p.tokens)) {
      try {
        const closed = await closeEmptyTokenAccount(this.ctx, p.mint as Address, p.tokenProgram as Address);
        if (closed?.status === 'confirmed') proceeds += this.ctx.rentTokenAccount;
      } catch (e) {
        this.ctx.log(`could not close the empty ${p.symbol} account: ${(e as Error).message}`);
      }
    }
    return { tokensSold: -r.tokenDelta, proceedsLamports: proceeds, signature: r.signature };
  }
  async reconcile(state: BotState, nowMs: number): Promise<string[]> {
    const notes: string[] = [];
    const balances = new Map<string, bigint>();
    for (const program of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      for (const { account } of await this.ctx.rpc.getTokenAccountsByOwner(this.ctx.wallet, program)) {
        if (account.data.length < 165) continue;
        const t = decodeTokenAccount(account.data);
        balances.set(t.mint, (balances.get(t.mint) ?? 0n) + t.amount);
      }
    }
    for (const p of state.positions) {
      const onChain = balances.get(p.mint) ?? 0n;
      if (onChain !== BigInt(p.tokens)) {
        notes.push(`${p.symbol}: state had ${p.tokens} units, chain has ${onChain}; using the chain`);
        p.tokens = onChain.toString();
      }
    }
    const pending = state.pendingBuy;
    if (pending) {
      const onChain = balances.get(pending.mint) ?? 0n;
      const tracked = state.positions.some((p) => p.mint === pending.mint);
      if (onChain > 0n && !tracked) {
        state.positions.push({
          mint: pending.mint,
          symbol: pending.symbol,
          decimals: pending.decimals,
          tokenProgram: pending.tokenProgram,
          openedAt: pending.at,
          costLamports: pending.lamports,
          tokens: onChain.toString(),
          realizedLamports: '0',
          peakValueLamports: pending.lamports,
          lastValueLamports: pending.lamports,
          takeProfitDone: false,
        });
        notes.push(`adopted ${pending.symbol}: an earlier buy did land`);
        state.pendingBuy = null;
      } else if (tracked || nowMs - pending.at > 3 * 60_000) {
        state.pendingBuy = null; // expired long ago: the transaction can no longer land
      }
    }
    const known = new Set([...state.positions.map((p) => p.mint), WSOL_MINT as string]);
    for (const [mint, amount] of balances) {
      if (amount > 0n && !known.has(mint)) notes.push(`untracked token ${mint} in wallet (ignored — never interact with unknown airdrops)`);
    }
    return notes;
  }
}

export interface EngineDeps {
  policy: BotPolicy;
  feed: TokenFeed;
  market: Market;
  rpc: Rpc;
  broker: Broker;
  store: StateStore;
  events: EventLog;
  wallet: Address;
  rentTokenAccount: bigint;
  isHalted: () => boolean;
  log: (line: string) => void;
  now: () => number;
}

/** Set by the strategy router: whether new entries are allowed and the most the bot may hold. */
export interface MomentumBudget {
  allowEntries: boolean;
  maxExposureLamports: bigint;
}

export interface TickReport {
  actions: string[];
  notes: string[];
  solLamports: bigint;
  equityLamports: bigint;
}

const H = 3_600_000;

export class Engine {
  private readonly d: EngineDeps;
  constructor(deps: EngineDeps) {
    this.d = deps;
  }

  async loadOrInit(paperStartLamports: bigint | null): Promise<BotState> {
    const { store, broker, wallet, now } = this.d;
    if (store.exists()) {
      const s = store.load();
      if (s.mode !== broker.mode) throw new Error(`${store.path} belongs to ${s.mode} mode`);
      if (s.wallet !== wallet) throw new Error(`${store.path} belongs to wallet ${s.wallet}`);
      return s;
    }
    const sol = broker.mode === 'paper' ? (paperStartLamports ?? 0n) : await this.d.rpc.getBalance(wallet);
    const s = newState(broker.mode, wallet, sol, now(), broker.mode === 'paper' ? sol : null);
    store.save(s);
    return s;
  }

  private exclusions(s: BotState, nowMs: number): Set<string> {
    const out = new Set<string>(s.positions.map((p) => p.mint));
    for (const [m, until] of Object.entries(s.cooldowns)) {
      if (until > nowMs) out.add(m);
      else delete s.cooldowns[m];
    }
    for (const [m, r] of Object.entries(s.rejects)) {
      if (r.until > nowMs) out.add(m);
      else delete s.rejects[m];
    }
    return out;
  }

  async tick(opts: { forceScan?: boolean; budget?: MomentumBudget } = {}): Promise<TickReport> {
    const { policy, broker, store, events, log } = this.d;
    const nowMs = this.d.now();
    const s = await this.loadOrInit(null);
    const report: TickReport = { actions: [], notes: [], solLamports: 0n, equityLamports: 0n };
    if (this.d.isHalted()) {
      report.notes.push('kill switch active: no trading this tick');
      return report;
    }
    report.notes.push(...(await broker.reconcile(s, nowMs)));
    s.positions = s.positions.filter((p) => BigInt(p.tokens) > 0n || this.closeTrade(s, p, 'reconciled: no tokens left', nowMs));

    // 1) Value positions and apply exit rules.
    for (const p of [...s.positions]) {
      try {
        await this.manage(s, p, nowMs, report);
      } catch (e) {
        report.notes.push(`${p.symbol}: ${(e as Error).message}`);
        events.append({ type: 'error', mint: p.mint, symbol: p.symbol, error: (e as Error).message });
      }
      store.save(s);
    }

    // 2) Maybe enter one new position.
    const sol = await broker.solBalance(s);
    const positionsValue = s.positions.reduce((a, p) => a + BigInt(p.lastValueLamports), 0n);
    report.solLamports = sol;
    report.equityLamports = sol + positionsValue;
    if (opts.forceScan || nowMs - s.lastScanAt >= policy.scanIntervalSeconds * 1000) {
      s.lastScanAt = nowMs;
      try {
        await this.scan(s, sol, report.equityLamports, nowMs, report, opts.budget);
      } catch (e) {
        report.notes.push(`scan failed: ${(e as Error).message}`);
      }
      store.save(s);
    }
    const after = await broker.solBalance(s);
    report.solLamports = after;
    report.equityLamports = after + s.positions.reduce((a, p) => a + BigInt(p.lastValueLamports), 0n);
    log(this.summaryLine(s, report));
    return report;
  }

  private closeTrade(s: BotState, p: PositionState, reason: string, nowMs: number): false {
    s.closed.push({ mint: p.mint, symbol: p.symbol, openedAt: p.openedAt, closedAt: nowMs, costLamports: p.costLamports, proceedsLamports: p.realizedLamports, reason });
    if (s.closed.length > 500) s.closed.splice(0, s.closed.length - 500);
    s.cooldowns[p.mint] = nowMs + this.d.policy.cooldownHours * H;
    return false;
  }

  private async manage(s: BotState, p: PositionState, nowMs: number, report: TickReport): Promise<void> {
    const { policy, market, broker, events } = this.d;
    const tokens = BigInt(p.tokens);
    const q = await market.quote({ inputMint: p.mint as Address, outputMint: WSOL_MINT, amount: tokens, slippageBps: policy.sellSlippageBps });
    const value = q.outAmount;
    p.lastValueLamports = value.toString();
    if (value > BigInt(p.peakValueLamports)) p.peakValueLamports = value.toString();
    const d = decideExit(
      { openedAt: p.openedAt, costLamports: BigInt(p.costLamports), realizedLamports: BigInt(p.realizedLamports), peakValueLamports: BigInt(p.peakValueLamports), takeProfitDone: p.takeProfitDone },
      value,
      nowMs,
      policy,
    );
    if (d.action === 'hold') return;
    const sellTokens = d.fraction >= 1 ? tokens : (tokens * BigInt(Math.round(d.fraction * 10_000))) / 10_000n;
    if (sellTokens <= 0n) return;
    let fill: SellFill | null;
    try {
      fill = await broker.sell(p, sellTokens, d.slippageBps, s);
    } catch (e) {
      if (e instanceof SwapRejected) {
        report.notes.push(`${p.symbol}: ${d.reason} sell refused: ${e.message} (will retry next tick)`);
        return;
      }
      throw e;
    }
    if (!fill) return;
    p.tokens = (tokens - fill.tokensSold).toString();
    p.realizedLamports = (BigInt(p.realizedLamports) + fill.proceedsLamports).toString();
    const pnl = Number(BigInt(p.realizedLamports) + (BigInt(p.tokens) > 0n ? (value * BigInt(p.tokens)) / tokens : 0n)) / Number(BigInt(p.costLamports)) - 1;
    report.actions.push(`${d.reason}: sold ${formatUnits(fill.tokensSold, p.decimals, 4)} ${p.symbol} for ${formatSol(fill.proceedsLamports, 4)} SOL (position ${(pnl * 100).toFixed(1)}%)`);
    events.append({ type: 'sell', mode: broker.mode, mint: p.mint, symbol: p.symbol, reason: d.reason, tokens: fill.tokensSold, proceedsLamports: fill.proceedsLamports, signature: fill.signature });
    if (d.reason === 'take-profit' && BigInt(p.tokens) > 0n) {
      p.takeProfitDone = true;
      p.peakValueLamports = ((value * BigInt(p.tokens)) / tokens).toString();
      p.lastValueLamports = p.peakValueLamports;
    }
    if (BigInt(p.tokens) === 0n) {
      this.closeTrade(s, p, d.reason, nowMs);
      s.positions = s.positions.filter((x) => x !== p);
    }
  }

  private async scan(s: BotState, sol: bigint, equity: bigint, nowMs: number, report: TickReport, budget?: MomentumBudget): Promise<void> {
    const { policy, feed, market, rpc, broker, events, store } = this.d;
    if (s.pendingBuy) {
      report.notes.push(`waiting to reconcile an earlier buy of ${s.pendingBuy.symbol}`);
      return;
    }
    if (budget && !budget.allowEntries) {
      report.notes.push('memecoin strategy is switched off for the current market regime: no new entries');
      return;
    }
    const size = positionSize({
      equityLamports: equity,
      solLamports: sol,
      openPositions: s.positions.length,
      policy,
      rentLamports: this.d.rentTokenAccount,
      ...(budget ? { budget: { maxExposureLamports: budget.maxExposureLamports, exposureLamports: s.positions.reduce((a, p) => a + BigInt(p.lastValueLamports), 0n) } } : {}),
    });
    if (size.lamports === null) {
      report.notes.push(size.reason);
      return;
    }
    const tokens = await feed.trending();
    const { passed } = rankCandidates(tokens, policy, nowMs, this.exclusions(s, nowMs));
    if (passed.length === 0) {
      report.notes.push(`no candidate passed the filters (${tokens.length} screened)`);
      return;
    }
    const reject = (t: TokenInfo, reason: string, hours = 24) => {
      s.rejects[t.mint] = { until: nowMs + hours * H, reason };
      events.append({ type: 'reject', mint: t.mint, symbol: t.symbol, reason });
    };
    for (const t of passed.slice(0, 5)) {
      const check = checkMintAccount(t.mint, await rpc.getAccountInfo(t.mint));
      if (!check.ok || !check.tokenProgram) {
        reject(t, check.reasons.join('; '));
        continue;
      }
      if (check.mint && check.mint.decimals !== t.decimals) {
        reject(t, `feed says ${t.decimals} decimals, chain says ${check.mint.decimals}`);
        continue;
      }
      let buyQuote: Quote;
      let backQuote: Quote;
      try {
        buyQuote = await market.quote({ inputMint: WSOL_MINT, outputMint: t.mint, amount: size.lamports, slippageBps: policy.buySlippageBps });
        backQuote = await market.quote({ inputMint: t.mint, outputMint: WSOL_MINT, amount: buyQuote.outAmount, slippageBps: policy.sellSlippageBps });
      } catch (e) {
        reject(t, `no route: ${(e as Error).message}`, 1);
        continue;
      }
      if (buyQuote.priceImpactPct > policy.maxPriceImpactPct) {
        reject(t, `price impact ${buyQuote.priceImpactPct.toFixed(2)}% > ${policy.maxPriceImpactPct}%`, 1);
        continue;
      }
      const roundTripLossPct = (1 - Number(backQuote.outAmount) / Number(size.lamports)) * 100;
      if (roundTripLossPct > policy.maxRoundTripLossPct) {
        reject(t, `buy-then-sell would lose ${roundTripLossPct.toFixed(1)}% (> ${policy.maxRoundTripLossPct}%): illiquid or taxed`, 6);
        continue;
      }
      const candidate: Candidate = { ...t, tokenProgram: check.tokenProgram };
      s.pendingBuy = { mint: t.mint, symbol: t.symbol, decimals: t.decimals, tokenProgram: check.tokenProgram, lamports: size.lamports.toString(), at: nowMs, signature: null };
      store.save(s); // write-ahead: a crash from here on is reconciled from the chain
      let fill: BuyFill | null;
      try {
        fill = await broker.buy(candidate, size.lamports, buyQuote, s);
      } catch (e) {
        s.pendingBuy = null;
        if (e instanceof SwapRejected) {
          reject(t, `buy refused: ${e.message}`, 6);
          continue;
        }
        throw e;
      }
      if (!fill) {
        // Only an unknown outcome leaves a signature on the marker; then reconciliation decides.
        if (!s.pendingBuy?.signature) s.pendingBuy = null;
        return;
      }
      s.pendingBuy = null;
      const value = (backQuote.outAmount * fill.tokens) / (buyQuote.outAmount || 1n);
      s.positions.push({
        mint: t.mint,
        symbol: t.symbol,
        decimals: t.decimals,
        tokenProgram: check.tokenProgram,
        openedAt: nowMs,
        costLamports: fill.costLamports.toString(),
        tokens: fill.tokens.toString(),
        realizedLamports: '0',
        peakValueLamports: value.toString(),
        lastValueLamports: value.toString(),
        takeProfitDone: false,
      });
      report.actions.push(`buy: ${formatSol(fill.costLamports, 4)} SOL -> ${formatUnits(fill.tokens, t.decimals, 4)} ${t.symbol} (1h ${t.stats1h.priceChangePct?.toFixed(0)}%, liquidity $${Math.round(t.liquidityUsd ?? 0)})`);
      events.append({ type: 'buy', mode: broker.mode, mint: t.mint, symbol: t.symbol, costLamports: fill.costLamports, tokens: fill.tokens, signature: fill.signature });
      return;
    }
  }

  async liquidate(): Promise<TickReport> {
    const { policy, broker, store, events } = this.d;
    const nowMs = this.d.now();
    const s = await this.loadOrInit(null);
    const report: TickReport = { actions: [], notes: [], solLamports: 0n, equityLamports: 0n };
    report.notes.push(...(await broker.reconcile(s, nowMs)));
    for (const p of [...s.positions]) {
      const tokens = BigInt(p.tokens);
      if (tokens === 0n) {
        this.closeTrade(s, p, 'liquidate: empty', nowMs);
        s.positions = s.positions.filter((x) => x !== p);
        continue;
      }
      try {
        const fill = await broker.sell(p, tokens, policy.emergencySlippageBps, s);
        if (!fill) {
          report.notes.push(`${p.symbol}: sell did not confirm; run liquidate again`);
          continue;
        }
        p.tokens = (tokens - fill.tokensSold).toString();
        p.realizedLamports = (BigInt(p.realizedLamports) + fill.proceedsLamports).toString();
        report.actions.push(`liquidated ${p.symbol} for ${formatSol(fill.proceedsLamports, 4)} SOL`);
        events.append({ type: 'sell', mode: broker.mode, mint: p.mint, symbol: p.symbol, reason: 'liquidate', tokens: fill.tokensSold, proceedsLamports: fill.proceedsLamports, signature: fill.signature });
        if (BigInt(p.tokens) === 0n) {
          this.closeTrade(s, p, 'liquidate', nowMs);
          s.positions = s.positions.filter((x) => x !== p);
        }
      } catch (e) {
        report.notes.push(`${p.symbol}: ${(e as Error).message}`);
      }
      store.save(s);
    }
    store.save(s);
    report.solLamports = await broker.solBalance(s);
    report.equityLamports = report.solLamports;
    return report;
  }

  summaryLine(s: BotState, r: TickReport): string {
    const start = BigInt(s.startEquityLamports);
    const pct = start > 0n ? (Number(r.equityLamports - start) / Number(start)) * 100 : 0;
    const pos = s.positions
      .map((p) => {
        const value = BigInt(p.lastValueLamports) + BigInt(p.realizedLamports);
        const ppct = (Number(value) / Number(BigInt(p.costLamports)) - 1) * 100;
        return `${p.symbol} ${ppct >= 0 ? '+' : ''}${ppct.toFixed(0)}%${p.takeProfitDone ? '*' : ''}`;
      })
      .join(', ');
    return `[${new Date(this.d.now()).toISOString()}] ${s.mode} | SOL ${formatSol(r.solLamports, 4)} | equity ${formatSol(r.equityLamports, 4)} (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}% since start) | ${pos || 'no positions'}${r.actions.length ? ` | ${r.actions.join('; ')}` : ''}`;
  }
}
