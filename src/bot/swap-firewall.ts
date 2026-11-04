// Firewall for aggregator-built swap transactions. The aggregator API proposes a
// transaction; this checks the fully resolved message (lookup tables included)
// before anything is signed:
//   * the wallet is the only signer and the fee payer
//   * only compute-budget, system, ATA, token and the Jupiter v6 program are called
//   * system transfers only wrap SOL into the wallet's own WSOL account
//   * token-program calls only sync/close the wallet's own WSOL account
//   * the Jupiter route moves the quoted amount, from and to the wallet's own
//     token accounts, with the quoted minimum output and no platform fee
// A simulation of the same bytes then has to produce the expected balance changes.

import { sha256 } from '@noble/hashes/sha2.js';
import type { Address } from '../crypto/keys.ts';
import { ASSOCIATED_TOKEN_PROGRAM_ID, COMPUTE_BUDGET_PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../solana/constants.ts';
import { deriveAssociatedTokenAddress } from '../solana/programs.ts';
import type { ResolvedInstruction, ResolvedMessage } from '../solana/versioned.ts';
import { bytesEqual, readU16le, readU32le, readU64le, readU8, utf8 } from '../util/bytes.ts';
import { JUPITER_V6_PROGRAM_ID, WSOL_MINT } from './jupiter.ts';

const anchorDiscriminator = (name: string): Uint8Array => sha256(utf8(`global:${name}`)).slice(0, 8);
export const JUPITER_ROUTE = anchorDiscriminator('route');
export const JUPITER_SHARED_ACCOUNTS_ROUTE = anchorDiscriminator('shared_accounts_route');

export interface SwapIntent {
  wallet: Address;
  inputMint: Address;
  outputMint: Address;
  inputTokenProgram: Address;
  outputTokenProgram: Address;
  inAmount: bigint;
  quotedOutAmount: bigint;
  slippageBps: number;
  maxPriorityFeeLamports: bigint;
}

export interface SwapFirewallReport {
  ok: boolean;
  violations: string[];
  actions: string[];
  priorityFeeLamports: bigint;
  /** Lamports the transaction wraps into WSOL (should equal inAmount for buys). */
  wrappedLamports: bigint;
}

const TOKEN_SYNC_NATIVE = 17;
const TOKEN_CLOSE_ACCOUNT = 9;
const SYSTEM_TRANSFER = 2;

export function inspectSwapTransaction(msg: ResolvedMessage, intent: SwapIntent): SwapFirewallReport {
  const violations: string[] = [];
  const actions: string[] = [];
  let unitLimit: number | null = null;
  let unitPrice: bigint | null = null;
  let wrappedLamports = 0n;
  let routes = 0;
  const w = intent.wallet;
  const wsolAta = deriveAssociatedTokenAddress(w, WSOL_MINT, TOKEN_PROGRAM_ID);
  const sourceAta = deriveAssociatedTokenAddress(w, intent.inputMint, intent.inputTokenProgram);
  const destinationAta = deriveAssociatedTokenAddress(w, intent.outputMint, intent.outputTokenProgram);

  if (msg.signers.length !== 1 || msg.signers[0] !== w) violations.push(`signers must be exactly [wallet], found [${msg.signers.join(', ')}]`);
  if (msg.view.staticAccountKeys[0] !== w) violations.push('fee payer is not the wallet');

  const accountAt = (ix: ResolvedInstruction, i: number) => ix.accounts[i]?.address;

  msg.instructions.forEach((ix, n) => {
    const label = `instruction ${n}`;
    const tag = ix.data[0];
    switch (ix.programId) {
      case COMPUTE_BUDGET_PROGRAM_ID: {
        if (tag === 2 && ix.data.length === 5 && unitLimit === null) unitLimit = readU32le(ix.data, 1);
        else if (tag === 3 && ix.data.length === 9 && unitPrice === null) unitPrice = readU64le(ix.data, 1);
        else violations.push(`${label}: unexpected or duplicate compute budget instruction`);
        return;
      }
      case SYSTEM_PROGRAM_ID: {
        if (ix.data.length !== 12 || readU32le(ix.data, 0) !== SYSTEM_TRANSFER) {
          violations.push(`${label}: only SOL transfers (to wrap SOL) are allowed on the system program`);
          return;
        }
        const lamports = readU64le(ix.data, 4);
        if (accountAt(ix, 0) !== w || accountAt(ix, 1) !== wsolAta) {
          violations.push(`${label}: SOL transfer to ${accountAt(ix, 1)} — only wrapping into the wallet's own WSOL account is allowed`);
          return;
        }
        wrappedLamports += lamports;
        actions.push(`wrap ${lamports} lamports into the wallet's WSOL account`);
        return;
      }
      case ASSOCIATED_TOKEN_PROGRAM_ID: {
        if (!(ix.data.length === 0 || (ix.data.length === 1 && (tag === 0 || tag === 1)))) {
          violations.push(`${label}: unexpected ATA instruction`);
          return;
        }
        const mint = accountAt(ix, 3);
        const tokenProgram = accountAt(ix, 5);
        if (!mint || ![intent.inputMint, intent.outputMint, WSOL_MINT].includes(mint)) {
          violations.push(`${label}: creates a token account for an unrelated mint ${mint}`);
          return;
        }
        if (tokenProgram !== TOKEN_PROGRAM_ID && tokenProgram !== TOKEN_2022_PROGRAM_ID) {
          violations.push(`${label}: unexpected token program ${tokenProgram}`);
          return;
        }
        const expected = deriveAssociatedTokenAddress(w, mint, tokenProgram);
        if (accountAt(ix, 0) !== w || accountAt(ix, 1) !== expected || accountAt(ix, 2) !== w || accountAt(ix, 4) !== SYSTEM_PROGRAM_ID) {
          violations.push(`${label}: token account creation is not for the wallet's own account`);
          return;
        }
        actions.push(`create the wallet's token account for ${mint === WSOL_MINT ? 'WSOL' : mint}`);
        return;
      }
      case TOKEN_PROGRAM_ID:
      case TOKEN_2022_PROGRAM_ID: {
        if (ix.data.length === 1 && tag === TOKEN_SYNC_NATIVE && accountAt(ix, 0) === wsolAta) {
          actions.push("sync the wallet's WSOL account");
          return;
        }
        if (ix.data.length === 1 && tag === TOKEN_CLOSE_ACCOUNT && accountAt(ix, 0) === wsolAta && accountAt(ix, 1) === w && accountAt(ix, 2) === w) {
          actions.push("unwrap: close the wallet's WSOL account back into the wallet");
          return;
        }
        violations.push(`${label}: token instruction ${tag} on ${accountAt(ix, 0)} is not allowed`);
        return;
      }
      case JUPITER_V6_PROGRAM_ID: {
        routes += 1;
        inspectRoute(ix, label);
        return;
      }
      default:
        violations.push(`${label}: program ${ix.programId} is not allowlisted`);
    }
  });

  function inspectRoute(ix: ResolvedInstruction, label: string): void {
    const disc = ix.data.slice(0, 8);
    const shared = bytesEqual(disc, JUPITER_SHARED_ACCOUNTS_ROUTE);
    if (!shared && !bytesEqual(disc, JUPITER_ROUTE)) {
      violations.push(`${label}: Jupiter instruction is not an exact-in route (unknown discriminator)`);
      return;
    }
    // Args end with: in_amount u64, quoted_out_amount u64, slippage_bps u16, platform_fee_bps u8.
    if (ix.data.length < 8 + 19) {
      violations.push(`${label}: Jupiter route data too short`);
      return;
    }
    const t = ix.data.length - 19;
    const inAmount = readU64le(ix.data, t);
    const quotedOut = readU64le(ix.data, t + 8);
    const slippage = readU16le(ix.data, t + 16);
    const platformFeeBps = readU8(ix.data, t + 18);
    if (inAmount !== intent.inAmount) violations.push(`${label}: route spends ${inAmount}, quote was ${intent.inAmount}`);
    if (quotedOut !== intent.quotedOutAmount) violations.push(`${label}: route quoted out ${quotedOut}, quote was ${intent.quotedOutAmount}`);
    if (slippage !== intent.slippageBps) violations.push(`${label}: route slippage ${slippage} bps, requested ${intent.slippageBps}`);
    if (platformFeeBps !== 0) violations.push(`${label}: route charges a ${platformFeeBps} bps platform fee`);

    const none = JUPITER_V6_PROGRAM_ID; // Anchor passes the program id for an absent optional account
    const [authority, source, dest, destMint, platformFee] = shared
      ? [accountAt(ix, 2), accountAt(ix, 3), accountAt(ix, 6), accountAt(ix, 8), accountAt(ix, 9)]
      : [accountAt(ix, 1), accountAt(ix, 2), accountAt(ix, 3), accountAt(ix, 5), accountAt(ix, 6)];
    if (authority !== w || !ix.accounts[shared ? 2 : 1]?.isSigner) violations.push(`${label}: route transfer authority is not the wallet`);
    if (source !== sourceAta) violations.push(`${label}: route source ${source} is not the wallet's ${intent.inputMint} account`);
    if (dest !== destinationAta) violations.push(`${label}: route destination ${dest} is not the wallet's ${intent.outputMint} account`);
    if (!shared && accountAt(ix, 4) !== destinationAta && accountAt(ix, 4) !== none) violations.push(`${label}: route forwards output to ${accountAt(ix, 4)}`);
    if (destMint !== intent.outputMint) violations.push(`${label}: route destination mint ${destMint} is not ${intent.outputMint}`);
    if (shared && accountAt(ix, 7) !== intent.inputMint) violations.push(`${label}: route source mint is not ${intent.inputMint}`);
    if (platformFee !== none) violations.push(`${label}: route has a platform fee account`);
    const minOut = (quotedOut * BigInt(10_000 - slippage)) / 10_000n;
    actions.push(`swap ${inAmount} of ${intent.inputMint === WSOL_MINT ? 'SOL' : intent.inputMint} for ≥ ${minOut} of ${intent.outputMint === WSOL_MINT ? 'SOL' : intent.outputMint} (program-enforced), into the wallet's own account`);
  }

  if (routes !== 1) violations.push(`expected exactly one Jupiter route instruction, found ${routes}`);
  if (intent.inputMint === WSOL_MINT && wrappedLamports > intent.inAmount) violations.push(`wraps ${wrappedLamports} lamports, more than the ${intent.inAmount} being swapped`);
  if (intent.inputMint !== WSOL_MINT && wrappedLamports > 0n) violations.push('wraps SOL although the swap does not spend SOL');
  // Without an explicit limit the runtime allows 200k CU per non-compute-budget instruction.
  const nonBudget = msg.instructions.filter((ix) => ix.programId !== COMPUTE_BUDGET_PROGRAM_ID).length;
  const limit = BigInt(unitLimit ?? Math.min(1_400_000, 200_000 * nonBudget));
  const price: bigint = unitPrice ?? 0n;
  const priorityFeeLamports = (limit * price + 999_999n) / 1_000_000n;
  if (priorityFeeLamports > intent.maxPriorityFeeLamports) {
    violations.push(`priority fee ${priorityFeeLamports} lamports exceeds the cap ${intent.maxPriorityFeeLamports}`);
  }
  return { ok: violations.length === 0, violations, actions, priorityFeeLamports, wrappedLamports };
}
