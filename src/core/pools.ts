// Loads every allowlisted stake pool and independently verifies it on-chain before
// it can be used. Config entries are claims; only what the chain proves is trusted.

import type { Address } from '../crypto/keys.ts';
import { decodeMint, decodeProgramData, decodeStakePool, decodeTokenAccount, decodeUpgradeableProgram, type Mint, type StakePool } from '../solana/accounts.ts';
import { BPF_UPGRADEABLE_LOADER_ID, STAKE_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../solana/constants.ts';
import { deriveWithdrawAuthority } from '../solana/programs.ts';
import type { AccountInfo, Rpc } from '../solana/rpc.ts';
import { annualize, exchangeRate, feeBps, feeRatio, lastEpochReturn } from './math.ts';
import type { ChainContext } from './chain.ts';
import type { Policy, PoolConfig } from './policy.ts';

export type IssueLevel = 'critical' | 'warning' | 'info';

export interface Issue {
  level: IssueLevel;
  code: string;
  message: string;
  blocksDeposit: boolean;
  blocksWithdraw: boolean;
}

export interface VerifiedPool {
  config: PoolConfig;
  pool: StakePool;
  mint: Mint;
  withdrawAuthority: Address;
  reserveLamports: bigint;
  /** SOL that WithdrawSol can pay out right now (reserve balance above its rent-exempt minimum). */
  reserveAvailableLamports: bigint;
}

export interface PoolMetrics {
  tvlLamports: bigint;
  /** Lamports per pool token. */
  rate: number;
  lastEpochReturn: number | null;
  /** Compounded annual yield implied by the last epoch, already net of the pool's reward fee. */
  apyEstimate: number | null;
  epochFeePct: number;
  solDepositFeeBps: number;
  solWithdrawalFeeBps: number;
  pendingEpochFeePct: number | null;
  pendingSolWithdrawalFeeBps: number | null;
  pendingStakeWithdrawalFeeBps: number | null;
  epochsSinceUpdate: bigint;
  /** Ranking score: capped APY minus entry and exit costs amortized over one year. */
  score: number | null;
}

export interface PoolEvaluation {
  config: PoolConfig;
  verified: VerifiedPool | null;
  metrics: PoolMetrics | null;
  issues: Issue[];
  depositable: boolean;
  withdrawable: boolean;
}

export interface ProgramStatus {
  program: Address;
  ok: boolean;
  lastDeploySlot: bigint | null;
  upgradeAuthority: Address | null;
  issues: Issue[];
}

const issue = (
  level: IssueLevel,
  code: string,
  message: string,
  blocks: { deposit?: boolean; withdraw?: boolean } = {},
): Issue => ({ level, code, message, blocksDeposit: blocks.deposit ?? false, blocksWithdraw: blocks.withdraw ?? false });

const BOTH = { deposit: true, withdraw: true } as const;

/** Identity checks: is this account really the pool the config claims? */
function verifyIdentity(
  config: PoolConfig,
  poolAccount: AccountInfo | null,
  mintAccount: AccountInfo | null,
  issues: Issue[],
): { pool: StakePool; mint: Mint; withdrawAuthority: Address } | null {
  if (!poolAccount) {
    issues.push(issue('critical', 'pool-missing', `stake pool account ${config.stakePool} does not exist`, BOTH));
    return null;
  }
  if (poolAccount.owner !== config.program) {
    issues.push(issue('critical', 'pool-owner', `stake pool account is owned by ${poolAccount.owner}, expected ${config.program}`, BOTH));
    return null;
  }
  let pool: StakePool;
  try {
    pool = decodeStakePool(poolAccount.data);
  } catch (e) {
    issues.push(issue('critical', 'pool-decode', `stake pool account could not be decoded: ${(e as Error).message}`, BOTH));
    return null;
  }
  if (pool.poolMint !== config.mint) {
    issues.push(issue('critical', 'pool-mint', `pool mint is ${pool.poolMint}, config says ${config.mint}`, BOTH));
    return null;
  }
  const [withdrawAuthority, bump] = deriveWithdrawAuthority(config.program, config.stakePool);
  if (bump !== pool.stakeWithdrawBumpSeed) {
    // A mismatch here means our decoding is misaligned or the account is not what it claims.
    issues.push(issue('critical', 'pool-bump', 'withdraw authority bump seed does not match derivation', BOTH));
    return null;
  }
  if (pool.tokenProgramId !== TOKEN_PROGRAM_ID) {
    issues.push(issue('critical', 'token-program', `pool uses token program ${pool.tokenProgramId}; only the classic SPL Token program is supported`, BOTH));
    return null;
  }
  if (!mintAccount) {
    issues.push(issue('critical', 'mint-missing', `mint ${config.mint} does not exist`, BOTH));
    return null;
  }
  if (mintAccount.owner !== pool.tokenProgramId) {
    issues.push(issue('critical', 'mint-owner', `mint is owned by ${mintAccount.owner}, expected ${pool.tokenProgramId}`, BOTH));
    return null;
  }
  let mint: Mint;
  try {
    mint = decodeMint(mintAccount.data);
  } catch (e) {
    issues.push(issue('critical', 'mint-decode', `mint could not be decoded: ${(e as Error).message}`, BOTH));
    return null;
  }
  if (!mint.isInitialized) {
    issues.push(issue('critical', 'mint-uninitialized', 'mint is not initialized', BOTH));
    return null;
  }
  if (mint.mintAuthority !== withdrawAuthority) {
    issues.push(issue('critical', 'mint-authority', "mint authority is not the pool's withdraw authority PDA", BOTH));
    return null;
  }
  if (mint.freezeAuthority !== null) {
    issues.push(issue('critical', 'mint-freeze', `mint has a freeze authority (${mint.freezeAuthority}); tokens could be frozen`, BOTH));
    return null;
  }
  if (mint.supply > pool.poolTokenSupply) {
    issues.push(issue('critical', 'supply-mismatch', 'mint supply exceeds the supply recorded by the pool', BOTH));
    return null;
  }
  if (mint.supply < pool.poolTokenSupply) {
    // Holders can burn their own tokens directly via the token program; harmless, but note it.
    issues.push(issue('info', 'supply-burned', `${(pool.poolTokenSupply - mint.supply).toString()} pool token base units were burned outside the pool`));
  }
  return { pool, mint, withdrawAuthority };
}

function poolPolicyChecks(v: VerifiedPool, ctx: ChainContext, policy: Policy, metrics: PoolMetrics, issues: Issue[]): void {
  const p = v.pool;
  const behind = metrics.epochsSinceUpdate;
  if (behind > 0n) {
    const level: IssueLevel = behind >= 2n ? 'critical' : 'warning';
    issues.push(
      issue(level, 'pool-stale', `pool was last updated in epoch ${p.lastUpdateEpoch} (current ${ctx.epoch}); deposits and withdrawals wait for its update crank`, BOTH),
    );
  }
  if (p.solDepositAuthority) {
    issues.push(issue('info', 'deposit-gated', 'SOL deposits require the pool\'s deposit authority signature', { deposit: true }));
  }
  if (p.solWithdrawAuthority) {
    issues.push(issue('warning', 'withdraw-gated', 'instant SOL withdrawals require the pool\'s withdraw authority; exit would depend on a third party', BOTH));
  }
  if (p.totalLamports < policy.minPoolTvlLamports) {
    issues.push(issue('warning', 'pool-small', `pool TVL is below the policy minimum`, { deposit: true }));
  }
  if (metrics.epochFeePct > policy.maxEpochFeePct) {
    issues.push(issue('warning', 'epoch-fee', `pool keeps ${metrics.epochFeePct.toFixed(2)}% of rewards (policy max ${policy.maxEpochFeePct}%)`, { deposit: true }));
  }
  if (metrics.pendingEpochFeePct !== null && metrics.pendingEpochFeePct > metrics.epochFeePct) {
    const over = metrics.pendingEpochFeePct > policy.maxEpochFeePct;
    issues.push(
      issue(over ? 'critical' : 'warning', 'epoch-fee-increase', `reward fee rising to ${metrics.pendingEpochFeePct.toFixed(2)}% in ${p.nextEpochFee?.epochsUntilActive} epoch(s)`, { deposit: over }),
    );
  }
  if (metrics.solDepositFeeBps > policy.maxSolDepositFeeBps) {
    issues.push(issue('warning', 'deposit-fee', `SOL deposit fee ${metrics.solDepositFeeBps.toFixed(1)} bps exceeds policy max ${policy.maxSolDepositFeeBps}`, { deposit: true }));
  }
  if (metrics.solWithdrawalFeeBps > policy.maxSolWithdrawalFeeBps) {
    issues.push(issue('warning', 'withdrawal-fee', `SOL withdrawal fee ${metrics.solWithdrawalFeeBps.toFixed(1)} bps exceeds policy max ${policy.maxSolWithdrawalFeeBps}`, { deposit: true }));
  }
  if (metrics.pendingSolWithdrawalFeeBps !== null && metrics.pendingSolWithdrawalFeeBps > metrics.solWithdrawalFeeBps) {
    const over = metrics.pendingSolWithdrawalFeeBps > policy.maxSolWithdrawalFeeBps;
    issues.push(
      issue(over ? 'critical' : 'warning', 'withdrawal-fee-increase', `SOL withdrawal fee rising to ${metrics.pendingSolWithdrawalFeeBps.toFixed(1)} bps in ${p.nextSolWithdrawalFee?.epochsUntilActive} epoch(s); exit before it applies if that matters`, { deposit: over }),
    );
  }
  if (metrics.pendingStakeWithdrawalFeeBps !== null) {
    issues.push(issue('info', 'stake-withdrawal-fee-change', `stake withdrawal fee changing to ${metrics.pendingStakeWithdrawalFeeBps.toFixed(1)} bps`));
  }
  if (metrics.lastEpochReturn !== null && metrics.lastEpochReturn < 0) {
    issues.push(issue('critical', 'value-decreased', 'pool token value DECREASED over the last epoch (slashing, exploit or accounting fault)', { deposit: true }));
  }
  if (metrics.apyEstimate !== null && metrics.apyEstimate * 100 > policy.aprSanityMaxPct) {
    issues.push(issue('info', 'apy-anomaly', `last-epoch APY estimate ${(metrics.apyEstimate * 100).toFixed(2)}% is implausibly high; treated as noise (capped)`));
  }
}

export function computeMetrics(v: VerifiedPool, ctx: ChainContext, policy: Policy): PoolMetrics {
  const p = v.pool;
  const r = lastEpochReturn(p);
  const apy = r === null ? null : annualize(r, ctx.epochsPerYear);
  const solDepositFeeBps = feeBps(p.solDepositFee);
  const solWithdrawalFeeBps = feeBps(p.solWithdrawalFee);
  const cappedApy = apy === null ? null : Math.min(apy, policy.aprSanityMaxPct / 100);
  return {
    tvlLamports: p.totalLamports,
    rate: exchangeRate(p),
    lastEpochReturn: r,
    apyEstimate: apy,
    epochFeePct: feeRatio(p.epochFee) * 100,
    solDepositFeeBps,
    solWithdrawalFeeBps,
    pendingEpochFeePct: p.nextEpochFee ? feeRatio(p.nextEpochFee.fee) * 100 : null,
    pendingSolWithdrawalFeeBps: p.nextSolWithdrawalFee ? feeBps(p.nextSolWithdrawalFee.fee) : null,
    pendingStakeWithdrawalFeeBps: p.nextStakeWithdrawalFee ? feeBps(p.nextStakeWithdrawalFee.fee) : null,
    epochsSinceUpdate: ctx.epoch > p.lastUpdateEpoch ? ctx.epoch - p.lastUpdateEpoch : 0n,
    score: cappedApy === null ? null : cappedApy - solDepositFeeBps / 10_000 - solWithdrawalFeeBps / 10_000,
  };
}

export async function evaluatePools(rpc: Rpc, configs: PoolConfig[], ctx: ChainContext, policy: Policy): Promise<PoolEvaluation[]> {
  const first = await rpc.getMultipleAccounts([...configs.map((c) => c.stakePool), ...configs.map((c) => c.mint)]);
  const partial = configs.map((config, i) => {
    const issues: Issue[] = [];
    const identity = verifyIdentity(config, first[i] ?? null, first[configs.length + i] ?? null, issues);
    return { config, issues, identity };
  });

  // Second round: accounts referenced by each verified pool.
  const refs: Address[] = [];
  for (const p of partial) {
    if (p.identity) refs.push(p.identity.pool.reserveStake, p.identity.pool.managerFeeAccount, p.identity.pool.validatorList);
  }
  const second = refs.length ? await rpc.getMultipleAccounts(refs) : [];

  let k = 0;
  return partial.map(({ config, issues, identity }) => {
    if (!identity) return { config, verified: null, metrics: null, issues, depositable: false, withdrawable: false };
    const reserve = second[k++] ?? null;
    const feeAccount = second[k++] ?? null;
    const validatorList = second[k++] ?? null;
    const { pool, mint, withdrawAuthority } = identity;

    let reserveLamports = 0n;
    if (!reserve || reserve.owner !== STAKE_PROGRAM_ID) {
      issues.push(issue('critical', 'reserve-invalid', 'reserve stake account is missing or not a stake account', BOTH));
    } else {
      reserveLamports = reserve.lamports;
    }
    if (!feeAccount || feeAccount.owner !== pool.tokenProgramId) {
      issues.push(issue('warning', 'fee-account-invalid', 'manager fee account is missing; the program will reject deposits', { deposit: true }));
    } else {
      try {
        if (decodeTokenAccount(feeAccount.data).mint !== pool.poolMint) {
          issues.push(issue('warning', 'fee-account-mint', 'manager fee account holds a different mint; deposits would fail', { deposit: true }));
        }
      } catch {
        issues.push(issue('warning', 'fee-account-decode', 'manager fee account is not a token account; deposits would fail', { deposit: true }));
      }
    }
    if (!validatorList || validatorList.owner !== config.program) {
      issues.push(issue('warning', 'validator-list', 'validator list account is missing or has an unexpected owner'));
    }

    const reserveAvailableLamports = reserveLamports > ctx.rentStakeAccount ? reserveLamports - ctx.rentStakeAccount : 0n;
    const verified: VerifiedPool = { config, pool, mint, withdrawAuthority, reserveLamports, reserveAvailableLamports };
    const metrics = computeMetrics(verified, ctx, policy);
    poolPolicyChecks(verified, ctx, policy, metrics, issues);
    return {
      config,
      verified,
      metrics,
      issues,
      depositable: !issues.some((x) => x.blocksDeposit),
      withdrawable: !issues.some((x) => x.blocksWithdraw),
    };
  });
}

/** Picks the depositable pool with the best score. Ties go to the larger pool. */
export function rankPools(evaluations: PoolEvaluation[]): PoolEvaluation[] {
  return [...evaluations].sort((a, b) => {
    if (a.depositable !== b.depositable) return a.depositable ? -1 : 1;
    const sa = a.metrics?.score ?? -Infinity;
    const sb = b.metrics?.score ?? -Infinity;
    if (sa !== sb) return sb - sa;
    const ta = a.metrics?.tvlLamports ?? 0n;
    const tb = b.metrics?.tvlLamports ?? 0n;
    return ta === tb ? 0 : tb > ta ? 1 : -1;
  });
}

/** Reads upgrade metadata for the stake pool program(s) so code changes are visible. */
export async function inspectPrograms(rpc: Rpc, programs: Address[], ctx: ChainContext): Promise<ProgramStatus[]> {
  const accounts = await rpc.getMultipleAccounts(programs);
  const out: ProgramStatus[] = [];
  for (let i = 0; i < programs.length; i++) {
    const program = programs[i] as Address;
    const acc = accounts[i] ?? null;
    const issues: Issue[] = [];
    if (!acc || !acc.executable) {
      out.push({ program, ok: false, lastDeploySlot: null, upgradeAuthority: null, issues: [issue('critical', 'program-missing', `program ${program} is not deployed`, BOTH)] });
      continue;
    }
    if (acc.owner !== BPF_UPGRADEABLE_LOADER_ID) {
      out.push({ program, ok: true, lastDeploySlot: null, upgradeAuthority: null, issues: [issue('info', 'program-immutable', 'program is not upgradeable')] });
      continue;
    }
    try {
      const programData = decodeUpgradeableProgram(acc.data);
      const pd = await rpc.getAccountInfo(programData);
      if (!pd) throw new Error('program data account missing');
      const { slot, upgradeAuthority } = decodeProgramData(pd.data);
      const recentWindow = ctx.slotsInEpoch * 2n;
      if (ctx.absoluteSlot - slot < recentWindow) {
        issues.push(issue('warning', 'program-upgraded', `stake pool program code was upgraded at slot ${slot} (within ~2 epochs); review release notes before depositing more`));
      }
      out.push({ program, ok: true, lastDeploySlot: slot, upgradeAuthority, issues });
    } catch (e) {
      out.push({ program, ok: false, lastDeploySlot: null, upgradeAuthority: null, issues: [issue('warning', 'program-inspect', `could not read program metadata: ${(e as Error).message}`)] });
    }
  }
  return out;
}
