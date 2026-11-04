// Instruction builders for the only programs this tool is allowed to call.
// Layouts come from the program sources (solana-program/stake-pool v2.2.0,
// SPL token / ATA, compute budget) and are byte-checked against the official
// JS clients in test/programs.test.ts.

import { addressToBytes, findProgramAddress, type Address } from '../crypto/keys.ts';
import { concatBytes, u32le, u64le, u8, utf8 } from '../util/bytes.ts';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  COMPUTE_BUDGET_PROGRAM_ID,
  STAKE_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  SYSVAR_CLOCK_ID,
  SYSVAR_STAKE_HISTORY_ID,
} from './constants.ts';
import type { AccountMeta, Instruction } from './tx.ts';

const w = (address: Address): AccountMeta => ({ address, isSigner: false, isWritable: true });
const r = (address: Address): AccountMeta => ({ address, isSigner: false, isWritable: false });
const ws = (address: Address): AccountMeta => ({ address, isSigner: true, isWritable: true });
const rs = (address: Address): AccountMeta => ({ address, isSigner: true, isWritable: false });

// ---------------------------------------------------------------- compute budget

export const COMPUTE_BUDGET_SET_UNIT_LIMIT = 2;
export const COMPUTE_BUDGET_SET_UNIT_PRICE = 3;

export function setComputeUnitLimit(units: number): Instruction {
  return { programId: COMPUTE_BUDGET_PROGRAM_ID, accounts: [], data: concatBytes(u8(COMPUTE_BUDGET_SET_UNIT_LIMIT), u32le(units)) };
}

export function setComputeUnitPrice(microLamports: bigint): Instruction {
  return { programId: COMPUTE_BUDGET_PROGRAM_ID, accounts: [], data: concatBytes(u8(COMPUTE_BUDGET_SET_UNIT_PRICE), u64le(microLamports)) };
}

// ---------------------------------------------------------------- SPL token / ATA

export function deriveAssociatedTokenAddress(owner: Address, mint: Address, tokenProgram: Address): Address {
  return findProgramAddress(
    [addressToBytes(owner), addressToBytes(tokenProgram), addressToBytes(mint)],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

export const ATA_CREATE_IDEMPOTENT = 1;

export function createAssociatedTokenAccountIdempotent(p: {
  payer: Address;
  ata: Address;
  owner: Address;
  mint: Address;
  tokenProgram: Address;
}): Instruction {
  return {
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    accounts: [ws(p.payer), w(p.ata), r(p.owner), r(p.mint), r(SYSTEM_PROGRAM_ID), r(p.tokenProgram)],
    data: u8(ATA_CREATE_IDEMPOTENT),
  };
}

export const TOKEN_CLOSE_ACCOUNT = 9;

/** Closes an (empty) token account, returning its rent lamports to `destination`. */
export function closeTokenAccount(p: { account: Address; destination: Address; owner: Address; tokenProgram: Address }): Instruction {
  return {
    programId: p.tokenProgram,
    accounts: [w(p.account), w(p.destination), rs(p.owner)],
    data: u8(TOKEN_CLOSE_ACCOUNT),
  };
}

// ---------------------------------------------------------------- SPL stake pool

/** Borsh enum discriminants of `StakePoolInstruction` (declaration order). */
export const STAKE_POOL_IX = {
  DepositSol: 14,
  WithdrawSol: 16,
  DepositSolWithSlippage: 25,
  WithdrawSolWithSlippage: 26,
} as const;

export function deriveWithdrawAuthority(programId: Address, stakePool: Address): [Address, number] {
  return findProgramAddress([addressToBytes(stakePool), utf8('withdraw')], programId);
}

export interface DepositSolParams {
  programId: Address;
  stakePool: Address;
  withdrawAuthority: Address;
  reserveStake: Address;
  /** Wallet paying the lamports (signer). */
  from: Address;
  /** Token account receiving the minted pool tokens. Must be the wallet's own ATA. */
  destination: Address;
  managerFeeAccount: Address;
  /** Receives the referral share of the deposit fee; we point this at our own ATA. */
  referrer: Address;
  poolMint: Address;
  tokenProgram: Address;
  lamports: bigint;
  /** When set, uses DepositSolWithSlippage so the program itself enforces the minimum. */
  minimumPoolTokensOut?: bigint;
}

export function depositSol(p: DepositSolParams): Instruction {
  const data =
    p.minimumPoolTokensOut === undefined
      ? concatBytes(u8(STAKE_POOL_IX.DepositSol), u64le(p.lamports))
      : concatBytes(u8(STAKE_POOL_IX.DepositSolWithSlippage), u64le(p.lamports), u64le(p.minimumPoolTokensOut));
  return {
    programId: p.programId,
    accounts: [
      w(p.stakePool),
      r(p.withdrawAuthority),
      w(p.reserveStake),
      ws(p.from),
      w(p.destination),
      w(p.managerFeeAccount),
      w(p.referrer),
      w(p.poolMint),
      r(SYSTEM_PROGRAM_ID),
      r(p.tokenProgram),
    ],
    data,
  };
}

export interface WithdrawSolParams {
  programId: Address;
  stakePool: Address;
  withdrawAuthority: Address;
  /** Owner of the source token account (signer). */
  transferAuthority: Address;
  /** Token account whose pool tokens are burned. */
  source: Address;
  reserveStake: Address;
  /** System account receiving the SOL. */
  destination: Address;
  managerFeeAccount: Address;
  poolMint: Address;
  tokenProgram: Address;
  poolTokens: bigint;
  /** When set, uses WithdrawSolWithSlippage so the program itself enforces the minimum. */
  minimumLamportsOut?: bigint;
}

export function withdrawSol(p: WithdrawSolParams): Instruction {
  const data =
    p.minimumLamportsOut === undefined
      ? concatBytes(u8(STAKE_POOL_IX.WithdrawSol), u64le(p.poolTokens))
      : concatBytes(u8(STAKE_POOL_IX.WithdrawSolWithSlippage), u64le(p.poolTokens), u64le(p.minimumLamportsOut));
  return {
    programId: p.programId,
    accounts: [
      w(p.stakePool),
      r(p.withdrawAuthority),
      rs(p.transferAuthority),
      w(p.source),
      w(p.reserveStake),
      w(p.destination),
      w(p.managerFeeAccount),
      w(p.poolMint),
      r(SYSVAR_CLOCK_ID),
      r(SYSVAR_STAKE_HISTORY_ID),
      r(STAKE_PROGRAM_ID),
      r(p.tokenProgram),
    ],
    data,
  };
}
