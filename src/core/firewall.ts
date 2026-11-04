// Transaction firewall: decodes the exact message bytes about to be signed and
// rejects anything outside a narrow allowlist. It deliberately re-derives every
// address it checks instead of trusting the builder, so a bug in the planner or
// builder cannot route funds anywhere but the wallet's own accounts.

import type { Address } from '../crypto/keys.ts';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  COMPUTE_BUDGET_PROGRAM_ID,
  STAKE_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  SYSVAR_CLOCK_ID,
  SYSVAR_STAKE_HISTORY_ID,
  TOKEN_PROGRAM_ID,
} from '../solana/constants.ts';
import {
  ATA_CREATE_IDEMPOTENT,
  COMPUTE_BUDGET_SET_UNIT_LIMIT,
  COMPUTE_BUDGET_SET_UNIT_PRICE,
  STAKE_POOL_IX,
  TOKEN_CLOSE_ACCOUNT,
  deriveAssociatedTokenAddress,
  deriveWithdrawAuthority,
} from '../solana/programs.ts';
import { decodeLegacyMessage, type DecodedInstruction } from '../solana/tx.ts';
import { readU32le, readU64le } from '../util/bytes.ts';
import type { VerifiedPool } from './pools.ts';

export interface FirewallRules {
  wallet: Address;
  /** Every verified pool (used to recognise the wallet's own pool-token accounts). */
  pools: VerifiedPool[];
  /** Stake pools that may receive a deposit right now (verified AND passing policy). */
  depositAllowed: ReadonlySet<Address>;
  /** Stake pools that may be redeemed from right now. */
  withdrawAllowed: ReadonlySet<Address>;
  maxPriorityFeeLamports: bigint;
  maxLamportsPerTransaction: bigint;
  requireSlippageGuard: boolean;
  maxComputeUnitLimit?: number;
}

export interface FirewallReport {
  ok: boolean;
  violations: string[];
  /** Human-readable list of what the transaction does, derived from the bytes. */
  actions: string[];
  lamportsDeposited: bigint;
  poolTokensWithdrawn: bigint;
  priorityFeeLamports: bigint;
}

export function inspectTransaction(messageBytes: Uint8Array, rules: FirewallRules): FirewallReport {
  const violations: string[] = [];
  const actions: string[] = [];
  let lamportsDeposited = 0n;
  let poolTokensWithdrawn = 0n;
  let unitLimit: number | null = null;
  let unitPrice: bigint | null = null;

  let msg;
  try {
    msg = decodeLegacyMessage(messageBytes);
  } catch (e) {
    return { ok: false, violations: [`message does not decode: ${(e as Error).message}`], actions, lamportsDeposited, poolTokensWithdrawn, priorityFeeLamports: 0n };
  }

  if (msg.numRequiredSignatures !== 1) violations.push(`expected exactly one signer, found ${msg.numRequiredSignatures}`);
  if (msg.accountKeys[0] !== rules.wallet) violations.push('fee payer is not the wallet');

  const byPool = new Map(rules.pools.map((p) => [p.config.stakePool, p]));
  const poolMints = new Map(rules.pools.map((p) => [p.pool.poolMint, p]));
  const allowedPrograms = new Set<Address>([COMPUTE_BUDGET_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, ...rules.pools.map((p) => p.config.program)]);
  const ataFor = (mint: Address): Address => deriveAssociatedTokenAddress(rules.wallet, mint, TOKEN_PROGRAM_ID);

  const expectAccounts = (ix: DecodedInstruction, expected: Address[], label: string): void => {
    if (ix.accounts.length !== expected.length) {
      violations.push(`${label}: expected ${expected.length} accounts, found ${ix.accounts.length}`);
      return;
    }
    expected.forEach((a, i) => {
      if (ix.accounts[i]?.address !== a) violations.push(`${label}: account #${i} is ${ix.accounts[i]?.address}, expected ${a}`);
    });
  };

  msg.instructions.forEach((ix, n) => {
    const label = `instruction ${n}`;
    if (!allowedPrograms.has(ix.programId)) {
      violations.push(`${label}: program ${ix.programId} is not allowlisted`);
      return;
    }
    const tag = ix.data[0];

    if (ix.programId === COMPUTE_BUDGET_PROGRAM_ID) {
      if (ix.accounts.length !== 0) violations.push(`${label}: compute budget instruction with accounts`);
      if (tag === COMPUTE_BUDGET_SET_UNIT_LIMIT && ix.data.length === 5 && unitLimit === null) {
        unitLimit = readU32le(ix.data, 1);
      } else if (tag === COMPUTE_BUDGET_SET_UNIT_PRICE && ix.data.length === 9 && unitPrice === null) {
        unitPrice = readU64le(ix.data, 1);
      } else {
        violations.push(`${label}: unexpected or duplicate compute budget instruction`);
      }
      return;
    }

    if (ix.programId === ASSOCIATED_TOKEN_PROGRAM_ID) {
      if (ix.data.length !== 1 || tag !== ATA_CREATE_IDEMPOTENT) {
        violations.push(`${label}: only CreateIdempotent is allowed on the ATA program`);
        return;
      }
      const mint = ix.accounts[3]?.address;
      if (!mint || !poolMints.has(mint)) {
        violations.push(`${label}: token account for a mint that is not an allowlisted pool token`);
        return;
      }
      expectAccounts(ix, [rules.wallet, ataFor(mint), rules.wallet, mint, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID], label);
      actions.push(`create the wallet's ${poolMints.get(mint)!.config.symbol} token account`);
      return;
    }

    if (ix.programId === TOKEN_PROGRAM_ID) {
      if (ix.data.length !== 1 || tag !== TOKEN_CLOSE_ACCOUNT) {
        violations.push(`${label}: only CloseAccount is allowed on the token program`);
        return;
      }
      const account = ix.accounts[0]?.address;
      const owned = rules.pools.find((p) => ataFor(p.pool.poolMint) === account);
      if (!owned) {
        violations.push(`${label}: CloseAccount on an account that is not the wallet's pool-token account`);
        return;
      }
      expectAccounts(ix, [ataFor(owned.pool.poolMint), rules.wallet, rules.wallet], label);
      actions.push(`close the wallet's ${owned.config.symbol} token account (rent back to wallet)`);
      return;
    }

    // Stake pool program.
    const poolAddr = ix.accounts[0]?.address;
    const v = poolAddr ? byPool.get(poolAddr) : undefined;
    if (!v || v.config.program !== ix.programId) {
      violations.push(`${label}: stake pool ${poolAddr} is not allowlisted for program ${ix.programId}`);
      return;
    }
    const p = v.pool;
    const [withdrawAuthority] = deriveWithdrawAuthority(v.config.program, v.config.stakePool);
    const ata = ataFor(p.poolMint);
    const guarded = tag === STAKE_POOL_IX.DepositSolWithSlippage || tag === STAKE_POOL_IX.WithdrawSolWithSlippage;
    if (rules.requireSlippageGuard && !guarded) violations.push(`${label}: policy requires the slippage-guarded instruction variant`);

    if (tag === STAKE_POOL_IX.DepositSol || tag === STAKE_POOL_IX.DepositSolWithSlippage) {
      if (ix.data.length !== (guarded ? 17 : 9)) {
        violations.push(`${label}: bad DepositSol data length`);
        return;
      }
      if (!rules.depositAllowed.has(v.config.stakePool)) violations.push(`${label}: ${v.config.symbol} is not currently allowed to receive deposits`);
      const lamports = readU64le(ix.data, 1);
      const minOut = guarded ? readU64le(ix.data, 9) : 0n;
      if (guarded && minOut === 0n) violations.push(`${label}: minimum pool tokens out is zero`);
      expectAccounts(
        ix,
        [v.config.stakePool, withdrawAuthority, p.reserveStake, rules.wallet, ata, p.managerFeeAccount, ata, p.poolMint, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID],
        label,
      );
      lamportsDeposited += lamports;
      actions.push(`deposit ${lamports} lamports into ${v.config.symbol}${guarded ? ` (program-enforced minimum ${minOut} pool token units)` : ''}, tokens to the wallet's own account`);
      return;
    }
    if (tag === STAKE_POOL_IX.WithdrawSol || tag === STAKE_POOL_IX.WithdrawSolWithSlippage) {
      if (ix.data.length !== (guarded ? 17 : 9)) {
        violations.push(`${label}: bad WithdrawSol data length`);
        return;
      }
      if (!rules.withdrawAllowed.has(v.config.stakePool)) violations.push(`${label}: ${v.config.symbol} is not currently allowed for withdrawals`);
      const tokens = readU64le(ix.data, 1);
      const minOut = guarded ? readU64le(ix.data, 9) : 0n;
      if (guarded && minOut === 0n) violations.push(`${label}: minimum lamports out is zero`);
      expectAccounts(
        ix,
        [
          v.config.stakePool,
          withdrawAuthority,
          rules.wallet,
          ata,
          p.reserveStake,
          rules.wallet,
          p.managerFeeAccount,
          p.poolMint,
          SYSVAR_CLOCK_ID,
          SYSVAR_STAKE_HISTORY_ID,
          STAKE_PROGRAM_ID,
          TOKEN_PROGRAM_ID,
        ],
        label,
      );
      poolTokensWithdrawn += tokens;
      actions.push(`redeem ${tokens} ${v.config.symbol} units for SOL paid to the wallet${guarded ? ` (program-enforced minimum ${minOut} lamports)` : ''}`);
      return;
    }
    violations.push(`${label}: stake pool instruction ${tag} is not allowed`);
  });

  const maxLimit = rules.maxComputeUnitLimit ?? 400_000;
  if (unitLimit === null || unitPrice === null) violations.push('transaction must set an explicit compute unit limit and price');
  const limit: number = unitLimit ?? 200_000;
  const price: bigint = unitPrice ?? 0n;
  if (limit > maxLimit) violations.push(`compute unit limit ${limit} exceeds ${maxLimit}`);
  const priorityFeeLamports = (BigInt(limit) * price + 999_999n) / 1_000_000n;
  if (priorityFeeLamports > rules.maxPriorityFeeLamports) {
    violations.push(`priority fee ${priorityFeeLamports} lamports exceeds policy cap ${rules.maxPriorityFeeLamports}`);
  }
  if (lamportsDeposited > rules.maxLamportsPerTransaction) violations.push('deposit exceeds policy maxSolPerTransaction');
  if (actions.length === 0) violations.push('transaction does nothing');

  return { ok: violations.length === 0, violations, actions, lamportsDeposited, poolTokensWithdrawn, priorityFeeLamports };
}
