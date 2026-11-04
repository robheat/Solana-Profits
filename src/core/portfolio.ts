// What the wallet holds, valued in SOL. Read-only: needs only the public address.

import type { Address } from '../crypto/keys.ts';
import { decodeTokenAccount, TOKEN_ACCOUNT_STATE, type TokenAccount } from '../solana/accounts.ts';
import { SYSTEM_PROGRAM_ID } from '../solana/constants.ts';
import { deriveAssociatedTokenAddress } from '../solana/programs.ts';
import type { Rpc } from '../solana/rpc.ts';
import { poolTokensToLamports } from './math.ts';
import type { Issue, PoolEvaluation } from './pools.ts';

export interface Position {
  evaluation: PoolEvaluation;
  ata: Address;
  exists: boolean;
  tokenAccount: TokenAccount | null;
  /** Rent held by the token account; returned when the account is closed. */
  ataLamports: bigint;
  tokens: bigint;
  /** SOL value of the tokens at the pool's current rate (before exit fees). */
  valueLamports: bigint;
  issues: Issue[];
}

export interface Portfolio {
  wallet: Address;
  walletExists: boolean;
  solLamports: bigint;
  positions: Position[];
  /** SOL + staked value + recoverable token-account rent. */
  totalValueLamports: bigint;
  issues: Issue[];
}

export async function loadPortfolio(rpc: Rpc, wallet: Address, evaluations: PoolEvaluation[]): Promise<Portfolio> {
  const candidates = evaluations.filter((e) => e.verified);
  const atas = candidates.map((e) => {
    const v = e.verified!;
    return deriveAssociatedTokenAddress(wallet, v.pool.poolMint, v.pool.tokenProgramId);
  });
  const [walletAccount, ...ataAccounts] = await rpc.getMultipleAccounts([wallet, ...atas]);
  const issues: Issue[] = [];
  if (walletAccount && walletAccount.owner !== SYSTEM_PROGRAM_ID) {
    issues.push({
      level: 'critical',
      code: 'wallet-not-system',
      message: `wallet account is owned by ${walletAccount.owner}; expected a plain system wallet`,
      blocksDeposit: true,
      blocksWithdraw: true,
    });
  }
  const solLamports = walletAccount?.lamports ?? 0n;

  const positions: Position[] = candidates.map((evaluation, i) => {
    const v = evaluation.verified!;
    const ata = atas[i] as Address;
    const acc = ataAccounts[i] ?? null;
    const posIssues: Issue[] = [];
    if (!acc) {
      return { evaluation, ata, exists: false, tokenAccount: null, ataLamports: 0n, tokens: 0n, valueLamports: 0n, issues: posIssues };
    }
    let tokenAccount: TokenAccount | null = null;
    if (acc.owner !== v.pool.tokenProgramId) {
      posIssues.push({ level: 'critical', code: 'ata-owner', message: 'token account has an unexpected program owner', blocksDeposit: true, blocksWithdraw: true });
    } else {
      try {
        tokenAccount = decodeTokenAccount(acc.data);
      } catch (e) {
        posIssues.push({ level: 'critical', code: 'ata-decode', message: `token account could not be decoded: ${(e as Error).message}`, blocksDeposit: true, blocksWithdraw: true });
      }
    }
    if (tokenAccount) {
      if (tokenAccount.owner !== wallet || tokenAccount.mint !== v.pool.poolMint) {
        posIssues.push({ level: 'critical', code: 'ata-mismatch', message: 'token account owner/mint mismatch', blocksDeposit: true, blocksWithdraw: true });
      }
      if (tokenAccount.state === TOKEN_ACCOUNT_STATE.Frozen) {
        posIssues.push({ level: 'critical', code: 'ata-frozen', message: 'token account is FROZEN', blocksDeposit: true, blocksWithdraw: true });
      }
      if (tokenAccount.delegate) {
        posIssues.push({
          level: 'critical',
          code: 'ata-delegate',
          message: `token account has a delegate (${tokenAccount.delegate}) approved to move ${tokenAccount.delegatedAmount} units; revoke it unless you set this up`,
          blocksDeposit: true,
          blocksWithdraw: false,
        });
      }
      if (tokenAccount.closeAuthority && tokenAccount.closeAuthority !== wallet) {
        posIssues.push({ level: 'critical', code: 'ata-close-authority', message: `token account close authority is ${tokenAccount.closeAuthority}`, blocksDeposit: true, blocksWithdraw: false });
      }
    }
    const tokens = tokenAccount?.amount ?? 0n;
    return {
      evaluation,
      ata,
      exists: true,
      tokenAccount,
      ataLamports: acc.lamports,
      tokens,
      valueLamports: poolTokensToLamports(v.pool, tokens),
      issues: posIssues,
    };
  });

  const totalValueLamports = positions.reduce((sum, p) => sum + p.valueLamports + p.ataLamports, solLamports);
  return { wallet, walletExists: walletAccount !== null, solLamports, positions, totalValueLamports, issues };
}
