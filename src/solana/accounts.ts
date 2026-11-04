// Decoders for the on-chain account types this tool reads.

import { addressFromBytes, type Address } from '../crypto/keys.ts';
import { readI64le, readU32le, readU64le, readU8 } from '../util/bytes.ts';

class Reader {
  private offset = 0;
  private readonly data: Uint8Array;
  constructor(data: Uint8Array) {
    this.data = data;
  }
  get position(): number {
    return this.offset;
  }
  u8(): number {
    return readU8(this.data, this.offset++);
  }
  u32(): number {
    const v = readU32le(this.data, this.offset);
    this.offset += 4;
    return v;
  }
  u64(): bigint {
    const v = readU64le(this.data, this.offset);
    this.offset += 8;
    return v;
  }
  i64(): bigint {
    const v = readI64le(this.data, this.offset);
    this.offset += 8;
    return v;
  }
  pubkey(): Address {
    if (this.offset + 32 > this.data.length) throw new RangeError('truncated pubkey');
    const v = addressFromBytes(this.data.slice(this.offset, this.offset + 32));
    this.offset += 32;
    return v;
  }
  /** Borsh Option<T>: 1-byte tag (0 = None, 1 = Some). */
  option<T>(read: () => T, what: string): T | null {
    const tag = this.u8();
    if (tag === 0) return null;
    if (tag === 1) return read();
    throw new Error(`invalid Option tag ${tag} for ${what}`);
  }
  /** SPL "COption<T>": 4-byte tag (0 = None, 1 = Some) followed by the value either way. */
  coption<T>(read: () => T, what: string): T | null {
    const tag = this.u32();
    const value = read();
    if (tag === 0) return null;
    if (tag === 1) return value;
    throw new Error(`invalid COption tag ${tag} for ${what}`);
  }
}

// ---------------------------------------------------------------- SPL stake pool

export interface Fee {
  denominator: bigint;
  numerator: bigint;
}

export interface FutureFee {
  fee: Fee;
  /** Epoch boundaries remaining before the fee takes effect (1 or 2). */
  epochsUntilActive: 1 | 2;
}

export interface Lockup {
  unixTimestamp: bigint;
  epoch: bigint;
  custodian: Address;
}

export const STAKE_POOL_ACCOUNT_TYPE = 1;

export interface StakePool {
  accountType: number;
  manager: Address;
  staker: Address;
  stakeDepositAuthority: Address;
  stakeWithdrawBumpSeed: number;
  validatorList: Address;
  reserveStake: Address;
  poolMint: Address;
  managerFeeAccount: Address;
  tokenProgramId: Address;
  totalLamports: bigint;
  poolTokenSupply: bigint;
  lastUpdateEpoch: bigint;
  lockup: Lockup;
  epochFee: Fee;
  nextEpochFee: FutureFee | null;
  preferredDepositValidatorVoteAddress: Address | null;
  preferredWithdrawValidatorVoteAddress: Address | null;
  stakeDepositFee: Fee;
  stakeWithdrawalFee: Fee;
  nextStakeWithdrawalFee: FutureFee | null;
  stakeReferralFee: number;
  solDepositAuthority: Address | null;
  solDepositFee: Fee;
  solReferralFee: number;
  solWithdrawAuthority: Address | null;
  solWithdrawalFee: Fee;
  nextSolWithdrawalFee: FutureFee | null;
  lastEpochPoolTokenSupply: bigint;
  lastEpochTotalLamports: bigint;
}

function readFee(rd: Reader): Fee {
  const denominator = rd.u64();
  const numerator = rd.u64();
  return { denominator, numerator };
}

/** FutureEpoch<Fee>: tag 0 = None, 1 = One(fee), 2 = Two(fee). */
function readFutureFee(rd: Reader, what: string): FutureFee | null {
  const tag = rd.u8();
  if (tag === 0) return null;
  if (tag === 1 || tag === 2) return { fee: readFee(rd), epochsUntilActive: tag };
  throw new Error(`invalid FutureEpoch tag ${tag} for ${what}`);
}

/** Decodes the Borsh `StakePool` struct (spl-stake-pool state.rs). Trailing padding is ignored. */
export function decodeStakePool(data: Uint8Array): StakePool {
  const rd = new Reader(data);
  const accountType = rd.u8();
  if (accountType !== STAKE_POOL_ACCOUNT_TYPE) throw new Error(`not a stake pool account (account_type=${accountType})`);
  const pool: StakePool = {
    accountType,
    manager: rd.pubkey(),
    staker: rd.pubkey(),
    stakeDepositAuthority: rd.pubkey(),
    stakeWithdrawBumpSeed: rd.u8(),
    validatorList: rd.pubkey(),
    reserveStake: rd.pubkey(),
    poolMint: rd.pubkey(),
    managerFeeAccount: rd.pubkey(),
    tokenProgramId: rd.pubkey(),
    totalLamports: rd.u64(),
    poolTokenSupply: rd.u64(),
    lastUpdateEpoch: rd.u64(),
    lockup: { unixTimestamp: rd.i64(), epoch: rd.u64(), custodian: rd.pubkey() },
    epochFee: readFee(rd),
    nextEpochFee: readFutureFee(rd, 'next_epoch_fee'),
    preferredDepositValidatorVoteAddress: rd.option(() => rd.pubkey(), 'preferred_deposit_validator'),
    preferredWithdrawValidatorVoteAddress: rd.option(() => rd.pubkey(), 'preferred_withdraw_validator'),
    stakeDepositFee: readFee(rd),
    stakeWithdrawalFee: readFee(rd),
    nextStakeWithdrawalFee: readFutureFee(rd, 'next_stake_withdrawal_fee'),
    stakeReferralFee: rd.u8(),
    solDepositAuthority: rd.option(() => rd.pubkey(), 'sol_deposit_authority'),
    solDepositFee: readFee(rd),
    solReferralFee: rd.u8(),
    solWithdrawAuthority: rd.option(() => rd.pubkey(), 'sol_withdraw_authority'),
    solWithdrawalFee: readFee(rd),
    nextSolWithdrawalFee: readFutureFee(rd, 'next_sol_withdrawal_fee'),
    lastEpochPoolTokenSupply: rd.u64(),
    lastEpochTotalLamports: rd.u64(),
  };
  if (pool.stakeReferralFee > 100 || pool.solReferralFee > 100) throw new Error('referral fee out of range');
  return pool;
}

// ---------------------------------------------------------------- SPL token

export const MINT_SIZE = 82;

export interface Mint {
  mintAuthority: Address | null;
  supply: bigint;
  decimals: number;
  isInitialized: boolean;
  freezeAuthority: Address | null;
}

export function decodeMint(data: Uint8Array): Mint {
  if (data.length < MINT_SIZE) throw new Error(`mint account too small (${data.length} bytes)`);
  const rd = new Reader(data);
  const mintAuthority = rd.coption(() => rd.pubkey(), 'mint_authority');
  const supply = rd.u64();
  const decimals = rd.u8();
  const initialized = rd.u8();
  if (initialized > 1) throw new Error('invalid mint is_initialized flag');
  const freezeAuthority = rd.coption(() => rd.pubkey(), 'freeze_authority');
  return { mintAuthority, supply, decimals, isInitialized: initialized === 1, freezeAuthority };
}

export const TOKEN_ACCOUNT_STATE = { Uninitialized: 0, Initialized: 1, Frozen: 2 } as const;

export interface TokenAccount {
  mint: Address;
  owner: Address;
  amount: bigint;
  delegate: Address | null;
  state: number;
  isNative: bigint | null;
  delegatedAmount: bigint;
  closeAuthority: Address | null;
}

export function decodeTokenAccount(data: Uint8Array): TokenAccount {
  if (data.length < 165) throw new Error(`token account too small (${data.length} bytes)`);
  const rd = new Reader(data);
  const account: TokenAccount = {
    mint: rd.pubkey(),
    owner: rd.pubkey(),
    amount: rd.u64(),
    delegate: rd.coption(() => rd.pubkey(), 'delegate'),
    state: rd.u8(),
    isNative: rd.coption(() => rd.u64(), 'is_native'),
    delegatedAmount: rd.u64(),
    closeAuthority: rd.coption(() => rd.pubkey(), 'close_authority'),
  };
  if (account.state > 2) throw new Error('invalid token account state');
  return account;
}

// ---------------------------------------------------------------- BPF upgradeable loader

/** UpgradeableLoaderState::Program { programdata_address } */
export function decodeUpgradeableProgram(data: Uint8Array): Address {
  const rd = new Reader(data);
  const tag = rd.u32();
  if (tag !== 2) throw new Error(`not an upgradeable program account (tag ${tag})`);
  return rd.pubkey();
}

export interface ProgramData {
  /** Slot of the most recent deployment / upgrade. */
  slot: bigint;
  upgradeAuthority: Address | null;
}

/** UpgradeableLoaderState::ProgramData { slot, upgrade_authority_address } */
export function decodeProgramData(data: Uint8Array): ProgramData {
  const rd = new Reader(data);
  const tag = rd.u32();
  if (tag !== 3) throw new Error(`not a program data account (tag ${tag})`);
  const slot = rd.u64();
  const upgradeAuthority = rd.option(() => rd.pubkey(), 'upgrade_authority');
  return { slot, upgradeAuthority };
}
