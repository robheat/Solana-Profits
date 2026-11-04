// Test fixtures encoded with the OFFICIAL libraries (@solana/spl-stake-pool,
// @solana/spl-token, @solana/web3.js), so every decode in src/ is checked
// against an independent implementation of the account layouts.

import { PublicKey, Keypair } from '@solana/web3.js';
import { StakePoolLayout } from '@solana/spl-stake-pool';
import { AccountLayout, MintLayout } from '@solana/spl-token';
import BN from 'bn.js';
import { toAddress, type Address } from '../src/crypto/keys.ts';
import { SPL_STAKE_POOL_PROGRAM_ID, STAKE_PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../src/solana/constants.ts';
import { deriveWithdrawAuthority } from '../src/solana/programs.ts';

export const pk = (a: string): PublicKey => new PublicKey(a);

let seedCounter = 1;
/** Deterministic distinct addresses for fixtures. */
export function newAddress(): Address {
  const seed = new Uint8Array(32);
  new DataView(seed.buffer).setUint32(0, seedCounter++, true);
  return toAddress(Keypair.fromSeed(seed).publicKey.toBase58());
}

export function deterministicKeypair(n: number): Keypair {
  const seed = new Uint8Array(32).fill(n);
  return Keypair.fromSeed(seed);
}

export interface FeeIn {
  numerator: bigint;
  denominator: bigint;
}
const fee = (f: FeeIn) => ({ numerator: new BN(f.numerator.toString()), denominator: new BN(f.denominator.toString()) });

export interface PoolFixture {
  stakePool: Address;
  program: Address;
  mint: Address;
  withdrawAuthority: Address;
  bump: number;
  reserveStake: Address;
  validatorList: Address;
  managerFeeAccount: Address;
  manager: Address;
  staker: Address;
  totalLamports: bigint;
  poolTokenSupply: bigint;
  lastUpdateEpoch: bigint;
  lastEpochTotalLamports: bigint;
  lastEpochPoolTokenSupply: bigint;
  epochFee: FeeIn;
  nextEpochFee: FeeIn | null;
  solDepositFee: FeeIn;
  solReferralFee: number;
  solWithdrawalFee: FeeIn;
  nextSolWithdrawalFee: FeeIn | null;
  stakeWithdrawalFee: FeeIn;
  nextStakeWithdrawalFee: FeeIn | null;
  stakeDepositFee: FeeIn;
  stakeReferralFee: number;
  solDepositAuthority: Address | null;
  solWithdrawAuthority: Address | null;
  preferredDeposit: Address | null;
  preferredWithdraw: Address | null;
  tokenProgramId: Address;
}

export function makePoolFixture(overrides: Partial<PoolFixture> = {}): PoolFixture {
  const stakePool = overrides.stakePool ?? newAddress();
  const program = overrides.program ?? SPL_STAKE_POOL_PROGRAM_ID;
  const [withdrawAuthority, bump] = deriveWithdrawAuthority(program, stakePool);
  return {
    stakePool,
    program,
    mint: newAddress(),
    withdrawAuthority,
    bump,
    reserveStake: newAddress(),
    validatorList: newAddress(),
    managerFeeAccount: newAddress(),
    manager: newAddress(),
    staker: newAddress(),
    // ~12M SOL pool at rate ~1.25 lamports/token
    totalLamports: 12_000_000_000_000_000n,
    poolTokenSupply: 9_600_000_000_000_000n,
    lastUpdateEpoch: 800n,
    // one epoch of ~7% APY growth (≈ 0.0371% per epoch at 182.5 epochs/yr)
    lastEpochTotalLamports: 11_995_550_000_000_000n,
    lastEpochPoolTokenSupply: 9_600_000_000_000_000n,
    epochFee: { numerator: 4n, denominator: 100n },
    nextEpochFee: null,
    solDepositFee: { numerator: 0n, denominator: 0n },
    solReferralFee: 0,
    solWithdrawalFee: { numerator: 1n, denominator: 1000n },
    nextSolWithdrawalFee: null,
    stakeWithdrawalFee: { numerator: 1n, denominator: 1000n },
    nextStakeWithdrawalFee: null,
    stakeDepositFee: { numerator: 0n, denominator: 0n },
    stakeReferralFee: 0,
    solDepositAuthority: null,
    solWithdrawAuthority: null,
    preferredDeposit: null,
    preferredWithdraw: null,
    tokenProgramId: TOKEN_PROGRAM_ID,
    ...overrides,
  };
}

// The official buffer-layout encoder SKIPS fields whose value is `undefined` (and then
// moves its offset by -1 for variable-length fields), so "None" must be passed as null,
// which its Option/FutureEpoch layouts encode as tag 0.
const NONE = null as unknown as undefined;

/** Encodes a StakePool account exactly like the official JS layout (padded like on-chain accounts). */
export function encodeStakePool(f: PoolFixture): Uint8Array {
  const buf = Buffer.alloc(611);
  StakePoolLayout.encode(
    {
      accountType: 1,
      manager: pk(f.manager),
      staker: pk(f.staker),
      stakeDepositAuthority: pk(SYSTEM_PROGRAM_ID),
      stakeWithdrawBumpSeed: f.bump,
      validatorList: pk(f.validatorList),
      reserveStake: pk(f.reserveStake),
      poolMint: pk(f.mint),
      managerFeeAccount: pk(f.managerFeeAccount),
      tokenProgramId: pk(f.tokenProgramId),
      totalLamports: new BN(f.totalLamports.toString()),
      poolTokenSupply: new BN(f.poolTokenSupply.toString()),
      lastUpdateEpoch: new BN(f.lastUpdateEpoch.toString()),
      lockup: { unixTimestamp: new BN(0), epoch: new BN(0), custodian: pk(SYSTEM_PROGRAM_ID) },
      epochFee: fee(f.epochFee),
      nextEpochFee: f.nextEpochFee ? fee(f.nextEpochFee) : NONE,
      preferredDepositValidatorVoteAddress: f.preferredDeposit ? pk(f.preferredDeposit) : NONE,
      preferredWithdrawValidatorVoteAddress: f.preferredWithdraw ? pk(f.preferredWithdraw) : NONE,
      stakeDepositFee: fee(f.stakeDepositFee),
      stakeWithdrawalFee: fee(f.stakeWithdrawalFee),
      nextStakeWithdrawalFee: f.nextStakeWithdrawalFee ? fee(f.nextStakeWithdrawalFee) : NONE,
      stakeReferralFee: f.stakeReferralFee,
      solDepositAuthority: f.solDepositAuthority ? pk(f.solDepositAuthority) : NONE,
      solDepositFee: fee(f.solDepositFee),
      solReferralFee: f.solReferralFee,
      solWithdrawAuthority: f.solWithdrawAuthority ? pk(f.solWithdrawAuthority) : NONE,
      solWithdrawalFee: fee(f.solWithdrawalFee),
      nextSolWithdrawalFee: f.nextSolWithdrawalFee ? fee(f.nextSolWithdrawalFee) : NONE,
      lastEpochPoolTokenSupply: new BN(f.lastEpochPoolTokenSupply.toString()),
      lastEpochTotalLamports: new BN(f.lastEpochTotalLamports.toString()),
    },
    buf,
  );
  return new Uint8Array(buf);
}

export function encodeMint(m: { mintAuthority: Address | null; supply: bigint; decimals?: number; freezeAuthority?: Address | null; isInitialized?: boolean }): Uint8Array {
  const buf = Buffer.alloc(MintLayout.span);
  MintLayout.encode(
    {
      mintAuthorityOption: m.mintAuthority ? 1 : 0,
      mintAuthority: pk(m.mintAuthority ?? SYSTEM_PROGRAM_ID),
      supply: m.supply,
      decimals: m.decimals ?? 9,
      isInitialized: m.isInitialized ?? true,
      freezeAuthorityOption: m.freezeAuthority ? 1 : 0,
      freezeAuthority: pk(m.freezeAuthority ?? SYSTEM_PROGRAM_ID),
    },
    buf,
  );
  return new Uint8Array(buf);
}

export function encodeTokenAccount(t: {
  mint: Address;
  owner: Address;
  amount: bigint;
  delegate?: Address | null;
  delegatedAmount?: bigint;
  state?: number;
  closeAuthority?: Address | null;
}): Uint8Array {
  const buf = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode(
    {
      mint: pk(t.mint),
      owner: pk(t.owner),
      amount: t.amount,
      delegateOption: t.delegate ? 1 : 0,
      delegate: pk(t.delegate ?? SYSTEM_PROGRAM_ID),
      state: t.state ?? 1,
      isNativeOption: 0,
      isNative: 0n,
      delegatedAmount: t.delegatedAmount ?? 0n,
      closeAuthorityOption: t.closeAuthority ? 1 : 0,
      closeAuthority: pk(t.closeAuthority ?? SYSTEM_PROGRAM_ID),
    },
    buf,
  );
  return new Uint8Array(buf);
}

export interface RawAccount {
  lamports: bigint;
  owner: Address;
  executable?: boolean;
  data: Uint8Array;
}

/** All accounts needed for one pool to verify cleanly. */
export function poolAccounts(f: PoolFixture, opts: { reserveLamports?: bigint; mintSupply?: bigint; freezeAuthority?: Address | null } = {}): Map<Address, RawAccount> {
  const m = new Map<Address, RawAccount>();
  m.set(f.stakePool, { lamports: 10_000_000n, owner: f.program, data: encodeStakePool(f) });
  m.set(f.mint, {
    lamports: 1_461_600n,
    owner: f.tokenProgramId,
    data: encodeMint({ mintAuthority: f.withdrawAuthority, supply: opts.mintSupply ?? f.poolTokenSupply, freezeAuthority: opts.freezeAuthority ?? null }),
  });
  m.set(f.reserveStake, { lamports: opts.reserveLamports ?? 50_000_000_000_000n, owner: STAKE_PROGRAM_ID, data: new Uint8Array(200) });
  m.set(f.managerFeeAccount, { lamports: 2_039_280n, owner: f.tokenProgramId, data: encodeTokenAccount({ mint: f.mint, owner: f.manager, amount: 1000n }) });
  m.set(f.validatorList, { lamports: 1_000_000n, owner: f.program, data: new Uint8Array(64) });
  return m;
}

export function poolConfigOf(f: PoolFixture, symbol: string) {
  return { symbol, name: `${symbol} test pool`, stakePool: f.stakePool, mint: f.mint, program: f.program };
}
