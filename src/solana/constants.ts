import { toAddress } from '../crypto/keys.ts';

export const SYSTEM_PROGRAM_ID = toAddress('11111111111111111111111111111111');
export const COMPUTE_BUDGET_PROGRAM_ID = toAddress('ComputeBudget111111111111111111111111111111');
export const TOKEN_PROGRAM_ID = toAddress('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const TOKEN_2022_PROGRAM_ID = toAddress('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const ASSOCIATED_TOKEN_PROGRAM_ID = toAddress('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const STAKE_PROGRAM_ID = toAddress('Stake11111111111111111111111111111111111111');
export const BPF_UPGRADEABLE_LOADER_ID = toAddress('BPFLoaderUpgradeab1e11111111111111111111111');
/** The canonical SPL stake pool program (solana-program/stake-pool). */
export const SPL_STAKE_POOL_PROGRAM_ID = toAddress('SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy');

export const SYSVAR_CLOCK_ID = toAddress('SysvarC1ock11111111111111111111111111111111');
export const SYSVAR_STAKE_HISTORY_ID = toAddress('SysvarStakeHistory1111111111111111111111111');

export const GENESIS_HASHES = {
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  testnet: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
} as const;

export const TOKEN_ACCOUNT_SIZE = 165;
export const STAKE_ACCOUNT_SIZE = 200;
/** Signature fee per required signature (lamports). */
export const BASE_FEE_LAMPORTS_PER_SIGNATURE = 5000n;
export const MAX_TRANSACTION_SIZE = 1232;
