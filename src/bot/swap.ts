// Executes one swap: fresh quote -> aggregator transaction -> resolve lookup tables ->
// swap firewall -> simulate and verify balance changes -> sign -> send -> confirm.

import type { Address, Signer } from '../crypto/keys.ts';
import { decodeTokenAccount } from '../solana/accounts.ts';
import { TOKEN_PROGRAM_ID } from '../solana/constants.ts';
import { describeTransactionError } from '../solana/errors.ts';
import { closeTokenAccount, deriveAssociatedTokenAddress, setComputeUnitLimit, setComputeUnitPrice } from '../solana/programs.ts';
import type { AccountInfo, Rpc } from '../solana/rpc.ts';
import { compileLegacyMessage, decodeLegacyMessage, signTransaction, unsignedTransaction } from '../solana/tx.ts';
import { ADDRESS_LOOKUP_TABLE_PROGRAM_ID, decodeLookupTable, decodeRawTransaction, decodeVersionedMessage, resolveMessage, signRawTransaction, type LookupTable } from '../solana/versioned.ts';
import { encodeBase58 } from '../util/base58.ts';
import { toBase64 } from '../util/bytes.ts';
import { sendAndConfirm, type SendOutcome } from '../core/executor.ts';
import type { JupiterClient, Quote } from './jupiter.ts';
import { WSOL_MINT } from './jupiter.ts';
import { inspectSwapTransaction } from './swap-firewall.ts';

export class SwapRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SwapRejected';
  }
}

export interface SwapContext {
  rpc: Rpc;
  jupiter: Pick<JupiterClient, 'quote' | 'swapTransaction'>;
  wallet: Address;
  /** null = simulate only (never signs). */
  signer: Signer | null;
  maxPriorityFeeLamports: bigint;
  rentTokenAccount: bigint;
  isHalted: () => boolean;
  log: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface SwapRequest {
  inputMint: Address;
  outputMint: Address;
  inputTokenProgram: Address;
  outputTokenProgram: Address;
  amount: bigint;
  slippageBps: number;
  maxPriceImpactPct: number;
}

export interface SwapResult {
  status: 'simulated' | SendOutcome['status'];
  signature: string | null;
  quote: Quote;
  /** Wallet SOL change (negative = spent), simulated or actual. */
  solDelta: bigint;
  /** Change of the non-SOL token in the wallet (positive = received). */
  tokenDelta: bigint;
  actions: string[];
  error?: string;
}

const tokenAmount = (a: AccountInfo | null | undefined): bigint => (a && a.lamports > 0n && a.data.length >= 165 ? decodeTokenAccount(a.data).amount : 0n);

async function loadLookupTables(rpc: Rpc, keys: Address[]): Promise<Map<Address, LookupTable>> {
  const tables = new Map<Address, LookupTable>();
  if (keys.length === 0) return tables;
  const accounts = await rpc.getMultipleAccounts(keys);
  keys.forEach((k, i) => {
    const acc = accounts[i];
    if (!acc || acc.owner !== ADDRESS_LOOKUP_TABLE_PROGRAM_ID) throw new SwapRejected(`lookup table ${k} is missing or not owned by the lookup table program`);
    tables.set(k, decodeLookupTable(acc.data));
  });
  return tables;
}

export async function executeSwap(ctx: SwapContext, req: SwapRequest): Promise<SwapResult> {
  const { rpc, wallet } = ctx;
  if (req.inputMint !== WSOL_MINT && req.outputMint !== WSOL_MINT) throw new SwapRejected('only SOL <-> token swaps are supported');
  const buying = req.inputMint === WSOL_MINT;
  const tokenMint = buying ? req.outputMint : req.inputMint;
  const tokenProgram = buying ? req.outputTokenProgram : req.inputTokenProgram;
  const tokenAta = deriveAssociatedTokenAddress(wallet, tokenMint, tokenProgram);

  const quote = await ctx.jupiter.quote({ inputMint: req.inputMint, outputMint: req.outputMint, amount: req.amount, slippageBps: req.slippageBps });
  if (quote.priceImpactPct > req.maxPriceImpactPct) {
    throw new SwapRejected(`price impact ${quote.priceImpactPct.toFixed(2)}% exceeds ${req.maxPriceImpactPct}%`);
  }
  const built = await ctx.jupiter.swapTransaction(quote, wallet, ctx.maxPriorityFeeLamports);
  const raw = decodeRawTransaction(built.transaction);
  const view = decodeVersionedMessage(raw.messageBytes);
  const tables = await loadLookupTables(rpc, view.addressTableLookups.map((l) => l.accountKey));
  const resolved = resolveMessage(view, tables);
  const firewall = inspectSwapTransaction(resolved, {
    wallet,
    inputMint: req.inputMint,
    outputMint: req.outputMint,
    inputTokenProgram: buying ? TOKEN_PROGRAM_ID : req.inputTokenProgram,
    outputTokenProgram: buying ? req.outputTokenProgram : TOKEN_PROGRAM_ID,
    inAmount: quote.inAmount,
    quotedOutAmount: quote.outAmount,
    slippageBps: quote.slippageBps,
    maxPriorityFeeLamports: ctx.maxPriorityFeeLamports,
  });
  if (!firewall.ok) throw new SwapRejected(`swap firewall rejected the aggregator transaction:\n  - ${firewall.violations.join('\n  - ')}`);

  // Simulate the exact bytes and check the balance changes against the quote.
  const watch = [wallet, tokenAta];
  const pre = await rpc.getMultipleAccounts(watch);
  const sim = await rpc.simulateTransaction(toBase64(built.transaction), watch);
  if (sim.err) {
    const ids = resolved.instructions.map((ix) => ix.programId as string);
    const d = describeTransactionError(sim.err, (i) => ids[i], []);
    throw new SwapRejected(`swap simulation failed: ${d.summary}${sim.logs.length ? `\n  last log: ${sim.logs[sim.logs.length - 1]}` : ''}`);
  }
  const maxFee = 5_000n + firewall.priorityFeeLamports;
  const preSol = pre[0]?.lamports ?? 0n;
  const simSol = (sim.accounts[0]?.lamports ?? 0n) - preSol;
  const simToken = tokenAmount(sim.accounts[1]) - tokenAmount(pre[1]);
  if (buying) {
    const rent = pre[1] ? 0n : ctx.rentTokenAccount;
    if (-simSol > quote.inAmount + maxFee + rent) throw new SwapRejected(`simulation: buy would spend ${-simSol} lamports, more than ${quote.inAmount} + fees + rent`);
    if (simToken < quote.otherAmountThreshold) throw new SwapRejected(`simulation: buy would deliver ${simToken} units, below the minimum ${quote.otherAmountThreshold}`);
  } else {
    if (-simToken !== quote.inAmount) throw new SwapRejected(`simulation: sell would move ${-simToken} units, expected ${quote.inAmount}`);
    if (simSol < quote.otherAmountThreshold - maxFee) throw new SwapRejected(`simulation: sell would return ${simSol} lamports, below the minimum ${quote.otherAmountThreshold} minus fees`);
  }

  if (!ctx.signer) return { status: 'simulated', signature: null, quote, solDelta: simSol, tokenDelta: simToken, actions: firewall.actions };
  if (ctx.isHalted()) throw new SwapRejected('kill switch is active; refusing to sign');
  if (ctx.signer.address !== wallet) throw new SwapRejected('signer does not match the wallet');

  const { tx, signature } = signRawTransaction(built.transaction, ctx.signer);
  const sigB58 = encodeBase58(signature);
  const lastValid = built.lastValidBlockHeight ?? (await rpc.getBlockHeight()) + 300n;
  const outcome = await sendAndConfirm({ rpc, log: ctx.log, ...(ctx.sleep ? { sleep: ctx.sleep } : {}), ...(ctx.now ? { now: ctx.now } : {}) }, toBase64(tx), sigB58, lastValid);
  if (outcome.status !== 'confirmed') {
    return { status: outcome.status, signature: sigB58, quote, solDelta: 0n, tokenDelta: 0n, actions: firewall.actions, error: 'error' in outcome ? outcome.error : outcome.status };
  }
  // Measure what actually happened (retry briefly: some RPC nodes lag the confirmation).
  let post = await rpc.getMultipleAccounts(watch);
  for (let i = 0; i < 3 && tokenAmount(post[1]) === tokenAmount(pre[1]); i++) {
    await (ctx.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))))(1_500);
    post = await rpc.getMultipleAccounts(watch);
  }
  return {
    status: 'confirmed',
    signature: sigB58,
    quote,
    solDelta: (post[0]?.lamports ?? 0n) - preSol,
    tokenDelta: tokenAmount(post[1]) - tokenAmount(pre[1]),
    actions: firewall.actions,
  };
}

/** Closes the wallet's empty token account for `mint`, refunding its rent. */
export async function closeEmptyTokenAccount(ctx: SwapContext, mint: Address, tokenProgram: Address): Promise<SendOutcome | null> {
  const ata = deriveAssociatedTokenAddress(ctx.wallet, mint, tokenProgram);
  const acc = await ctx.rpc.getAccountInfo(ata);
  if (!acc) return null;
  if (decodeTokenAccount(acc.data).amount !== 0n) throw new SwapRejected('token account is not empty');
  if (!ctx.signer) return null;
  if (ctx.isHalted()) throw new SwapRejected('kill switch is active; refusing to sign');
  const { blockhash, lastValidBlockHeight } = await ctx.rpc.getLatestBlockhash();
  const msg = compileLegacyMessage(
    ctx.wallet,
    [setComputeUnitLimit(10_000), setComputeUnitPrice(10_000n), closeTokenAccount({ account: ata, destination: ctx.wallet, owner: ctx.wallet, tokenProgram })],
    blockhash,
  );
  // Independent check of the bytes: one signer, only compute budget + this one CloseAccount.
  const d = decodeLegacyMessage(msg.bytes);
  const close = d.instructions[2];
  if (d.numRequiredSignatures !== 1 || d.instructions.length !== 3 || !close || close.programId !== tokenProgram || close.accounts[0]?.address !== ata || close.accounts[1]?.address !== ctx.wallet) {
    throw new SwapRejected('close-account transaction failed its self-check');
  }
  const sim = await ctx.rpc.simulateTransaction(toBase64(unsignedTransaction(msg)), [ctx.wallet]);
  if (sim.err) throw new SwapRejected(`close-account simulation failed: ${JSON.stringify(sim.err)}`);
  const { tx, signature } = signTransaction(msg, [ctx.signer]);
  return sendAndConfirm({ rpc: ctx.rpc, log: ctx.log, ...(ctx.sleep ? { sleep: ctx.sleep } : {}), ...(ctx.now ? { now: ctx.now } : {}) }, toBase64(tx), encodeBase58(signature), lastValidBlockHeight);
}
