// Mock Jupiter quote/swap/tokens API. Swap transactions are built with the official
// web3.js / spl-token builders in the same shape Jupiter uses (wrap SOL, ATA creation,
// shared_accounts_route, unwrap) as v0 messages through an address lookup table,
// and the MockChain executes them at the current mock price.

import { createServer, type Server } from 'node:http';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { toAddress, type Address } from '../src/crypto/keys.ts';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../src/solana/constants.ts';
import { concatBytes, u16le, u32le, u64le } from '../src/util/bytes.ts';
import { parseQuote, WSOL_MINT, JUPITER_V6_PROGRAM_ID, type Quote, type SwapTransaction } from '../src/bot/jupiter.ts';
import { parseToken, type TokenFeed, type TokenInfo } from '../src/bot/feed.ts';
import { encodeMint, newAddress } from './fixtures.ts';
import type { MockChain } from './mock-chain.ts';

export const ALT_PROGRAM = 'AddressLookupTab1e1111111111111111111111111';

export function lookupTableData(addresses: string[]): Uint8Array {
  const meta = new Uint8Array(56);
  meta.set(u32le(1), 0);
  meta.set(u64le(2n ** 64n - 1n), 4);
  return concatBytes(meta, ...addresses.map((a) => new PublicKey(a).toBytes()));
}

export interface MockToken {
  mint: Address;
  symbol: string;
  decimals: number;
  tokenProgram: Address;
  /** SOL value of one whole token, in lamports. */
  lamportsPerToken: number;
}

const pk = (a: string) => new PublicKey(a);
const SCALE = 1_000_000n;

export class MockJupiter {
  readonly chain: MockChain;
  readonly tokens = new Map<string, MockToken>();
  feeBps = 25n;
  priceImpact = '0.001';
  readonly lookupTable: Address;
  readonly programAuthority = newAddress();
  readonly programSource = newAddress();
  readonly programDestination = newAddress();
  readonly eventAuthority = newAddress();
  /** Optional transformation of the instruction list, to simulate a malicious or buggy API. */
  tamper: ((ixs: TransactionInstruction[], user: PublicKey) => TransactionInstruction[]) | null = null;
  /** Raw Jupiter-Tokens-v2-shaped entries served by the feed. */
  feed: Record<string, unknown>[] = [];
  quotes = 0;
  swaps = 0;

  constructor(chain: MockChain) {
    this.chain = chain;
    this.lookupTable = newAddress();
    chain.setAccount(this.lookupTable, {
      lamports: 10_000_000n,
      owner: toAddress(ALT_PROGRAM),
      data: lookupTableData([TOKEN_PROGRAM_ID, this.programAuthority, this.programSource, this.programDestination, this.eventAuthority, WSOL_MINT]),
    });
    chain.setAccount(WSOL_MINT, { lamports: 1_000_000n, owner: TOKEN_PROGRAM_ID, data: encodeMint({ mintAuthority: null, supply: 1n, decimals: 9 }) });
    chain.swapPricer = (i, o, amt) => this.out(i, o, amt);
  }

  addToken(t: Omit<MockToken, 'mint'> & { mint?: Address; mintAuthority?: Address | null; freezeAuthority?: Address | null; mintData?: Uint8Array }): MockToken {
    const token: MockToken = { mint: t.mint ?? newAddress(), symbol: t.symbol, decimals: t.decimals, tokenProgram: t.tokenProgram, lamportsPerToken: t.lamportsPerToken };
    this.tokens.set(token.mint, token);
    this.chain.setAccount(token.mint, {
      lamports: 1_461_600n,
      owner: t.tokenProgram,
      data: t.mintData ?? encodeMint({ mintAuthority: t.mintAuthority ?? null, supply: 10n ** 18n, decimals: t.decimals, freezeAuthority: t.freezeAuthority ?? null }),
    });
    return token;
  }

  setPrice(mint: Address, lamportsPerToken: number): void {
    this.tokens.get(mint)!.lamportsPerToken = lamportsPerToken;
  }

  out(inputMint: string, outputMint: string, amount: bigint): bigint {
    const fee = (x: bigint) => (x * (10_000n - this.feeBps)) / 10_000n;
    if (inputMint === WSOL_MINT) {
      const t = this.tokens.get(outputMint)!;
      const price = BigInt(Math.round(t.lamportsPerToken * Number(SCALE)));
      return fee((amount * 10n ** BigInt(t.decimals) * SCALE) / price);
    }
    const t = this.tokens.get(inputMint)!;
    const price = BigInt(Math.round(t.lamportsPerToken * Number(SCALE)));
    return fee((amount * price) / (10n ** BigInt(t.decimals) * SCALE));
  }

  rawQuote(p: { inputMint: string; outputMint: string; amount: bigint; slippageBps: number }): Record<string, unknown> {
    const tokenMint = p.inputMint === WSOL_MINT ? p.outputMint : p.inputMint;
    if (!this.tokens.has(tokenMint)) throw new Error(`no route for ${tokenMint}`);
    const out = this.out(p.inputMint, p.outputMint, p.amount);
    return {
      inputMint: p.inputMint,
      inAmount: p.amount.toString(),
      outputMint: p.outputMint,
      outAmount: out.toString(),
      otherAmountThreshold: ((out * BigInt(10_000 - p.slippageBps)) / 10_000n).toString(),
      swapMode: 'ExactIn',
      slippageBps: p.slippageBps,
      platformFee: null,
      priceImpactPct: this.priceImpact,
      routePlan: [{ swapInfo: { ammKey: this.programSource, label: 'MockAMM', inputMint: p.inputMint, outputMint: p.outputMint, inAmount: p.amount.toString(), outAmount: out.toString(), feeAmount: '0', feeMint: p.inputMint }, percent: 100 }],
      contextSlot: 1,
      timeTaken: 0.001,
    };
  }

  async quote(p: { inputMint: Address; outputMint: Address; amount: bigint; slippageBps: number }): Promise<Quote> {
    this.quotes++;
    return parseQuote(this.rawQuote(p));
  }

  buildSwap(quoteRaw: Record<string, unknown>, user: string, maxPriorityFeeLamports: bigint): SwapTransaction {
    this.swaps++;
    const u = pk(user);
    const inputMint = String(quoteRaw.inputMint);
    const outputMint = String(quoteRaw.outputMint);
    const inAmount = BigInt(String(quoteRaw.inAmount));
    const quotedOut = BigInt(String(quoteRaw.outAmount));
    const slippage = Number(quoteRaw.slippageBps);
    const buy = inputMint === WSOL_MINT;
    const tokenMint = buy ? outputMint : inputMint;
    const tokenProgram = pk(this.tokens.get(tokenMint)!.tokenProgram);
    const wsolAta = getAssociatedTokenAddressSync(pk(WSOL_MINT), u);
    const tokenAta = getAssociatedTokenAddressSync(pk(tokenMint), u, false, tokenProgram);
    const units = 300_000;
    const microLamports = (maxPriorityFeeLamports * 1_000_000n) / BigInt(units) / 2n;
    let ixs: TransactionInstruction[] = [
      ComputeBudgetProgram.setComputeUnitLimit({ units }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
      createAssociatedTokenAccountIdempotentInstruction(u, wsolAta, u, pk(WSOL_MINT)),
    ];
    if (buy) {
      ixs.push(SystemProgram.transfer({ fromPubkey: u, toPubkey: wsolAta, lamports: inAmount }), createSyncNativeInstruction(wsolAta));
      ixs.push(createAssociatedTokenAccountIdempotentInstruction(u, tokenAta, u, pk(tokenMint), tokenProgram));
    }
    const disc = sha256(new TextEncoder().encode('global:shared_accounts_route')).slice(0, 8);
    const data = concatBytes(disc, Uint8Array.of(0), u32le(0), u64le(inAmount), u64le(quotedOut), u16le(slippage), Uint8Array.of(0));
    const jup = pk(JUPITER_V6_PROGRAM_ID);
    ixs.push(
      new TransactionInstruction({
        programId: jup,
        keys: [
          { pubkey: pk(TOKEN_PROGRAM_ID), isSigner: false, isWritable: false },
          { pubkey: pk(this.programAuthority), isSigner: false, isWritable: false },
          { pubkey: u, isSigner: true, isWritable: false },
          { pubkey: buy ? wsolAta : tokenAta, isSigner: false, isWritable: true },
          { pubkey: pk(this.programSource), isSigner: false, isWritable: true },
          { pubkey: pk(this.programDestination), isSigner: false, isWritable: true },
          { pubkey: buy ? tokenAta : wsolAta, isSigner: false, isWritable: true },
          { pubkey: pk(inputMint), isSigner: false, isWritable: false },
          { pubkey: pk(outputMint), isSigner: false, isWritable: false },
          { pubkey: jup, isSigner: false, isWritable: false },
          { pubkey: tokenProgram.toBase58() === TOKEN_2022_PROGRAM_ID ? tokenProgram : jup, isSigner: false, isWritable: false },
          { pubkey: pk(this.eventAuthority), isSigner: false, isWritable: false },
          { pubkey: jup, isSigner: false, isWritable: false },
        ],
        data: Buffer.from(data),
      }),
    );
    ixs.push(createCloseAccountInstruction(wsolAta, u, u));
    if (this.tamper) ixs = this.tamper(ixs, u);
    const bh = this.chain.handle('getLatestBlockhash', []) as { value: { blockhash: string; lastValidBlockHeight: number } };
    const alt = new AddressLookupTableAccount({ key: pk(this.lookupTable), state: AddressLookupTableAccount.deserialize(this.chain.accounts.get(this.lookupTable)!.data) });
    const msg = new TransactionMessage({ payerKey: u, recentBlockhash: bh.value.blockhash, instructions: ixs }).compileToV0Message([alt]);
    return { transaction: new VersionedTransaction(msg).serialize(), lastValidBlockHeight: BigInt(bh.value.lastValidBlockHeight) };
  }

  async swapTransaction(quote: Quote, user: Address, maxPriorityFeeLamports: bigint): Promise<SwapTransaction> {
    return this.buildSwap(quote.raw, user, maxPriorityFeeLamports);
  }

  /** A feed entry that passes the default filters unless overridden. */
  feedEntry(t: MockToken, overrides: Record<string, unknown> = {}, nowMs = Date.now()): Record<string, unknown> {
    return {
      id: t.mint,
      name: `${t.symbol} coin`,
      symbol: t.symbol,
      decimals: t.decimals,
      tokenProgram: t.tokenProgram,
      holderCount: 5_000,
      organicScore: 80,
      isVerified: false,
      liquidity: 500_000,
      mcap: 10_000_000,
      usdPrice: 0.01,
      firstPool: { id: newAddress(), createdAt: new Date(nowMs - 3 * 86_400_000).toISOString() },
      audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 15, devBalancePercentage: 0.5 },
      stats5m: { priceChange: 2, buyVolume: 20_000, sellVolume: 15_000, numBuys: 100, numSells: 80 },
      stats1h: { priceChange: 40, buyVolume: 200_000, sellVolume: 120_000, numBuys: 900, numSells: 700 },
      ...overrides,
    };
  }
}

export class MockFeed implements TokenFeed {
  readonly jup: MockJupiter;
  constructor(jup: MockJupiter) {
    this.jup = jup;
  }
  async trending(): Promise<TokenInfo[]> {
    return this.jup.feed.map(parseToken).filter((t): t is TokenInfo => t !== null);
  }
}

/** Serves MockJupiter over HTTP (quote, swap, tokens) for CLI end-to-end tests. */
export async function serveMockJupiter(jup: MockJupiter): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        let result: unknown;
        if (req.method === 'GET' && url.pathname === '/swap/v1/quote') {
          result = jup.rawQuote({
            inputMint: url.searchParams.get('inputMint')!,
            outputMint: url.searchParams.get('outputMint')!,
            amount: BigInt(url.searchParams.get('amount')!),
            slippageBps: Number(url.searchParams.get('slippageBps')),
          });
          jup.quotes++;
        } else if (req.method === 'POST' && url.pathname === '/swap/v1/swap') {
          const b = JSON.parse(body) as { quoteResponse: Record<string, unknown>; userPublicKey: string; prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: number } } };
          const built = jup.buildSwap(b.quoteResponse, b.userPublicKey, BigInt(b.prioritizationFeeLamports.priorityLevelWithMaxLamports.maxLamports));
          result = { swapTransaction: Buffer.from(built.transaction).toString('base64'), lastValidBlockHeight: Number(built.lastValidBlockHeight) };
        } else if (req.method === 'GET' && url.pathname.startsWith('/tokens/v2/')) {
          result = jup.feed;
        } else {
          res.statusCode = 404;
          res.end('{"error":"not found"}');
          return;
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(result));
      } catch (e) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: (e as Error).message }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address() as { port: number };
  return { url: `http://127.0.0.1:${a.port}`, server };
}
