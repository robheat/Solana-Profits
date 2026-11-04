// Cluster-level facts every command needs: are we on the right network, what
// epoch is it, how many epochs per year, current rent.

import type { Rpc } from '../solana/rpc.ts';
import { GENESIS_HASHES, STAKE_ACCOUNT_SIZE, TOKEN_ACCOUNT_SIZE } from '../solana/constants.ts';
import type { Policy } from './policy.ts';

export interface ChainContext {
  genesisHash: string;
  /** True when the RPC's genesis hash matches policy.cluster. Signing requires this. */
  clusterVerified: boolean;
  epoch: bigint;
  slotIndex: bigint;
  slotsInEpoch: bigint;
  absoluteSlot: bigint;
  avgSlotSeconds: number;
  epochsPerYear: number;
  rentTokenAccount: bigint;
  rentStakeAccount: bigint;
}

const SECONDS_PER_YEAR = 365.25 * 24 * 3600;
const DEFAULT_SLOT_SECONDS = 0.4;

export async function loadChainContext(rpc: Rpc, policy: Policy): Promise<ChainContext> {
  const [genesisHash, epochInfo, schedule, samples, rentTokenAccount, rentStakeAccount] = await Promise.all([
    rpc.getGenesisHash(),
    rpc.getEpochInfo(),
    rpc.getEpochSchedule(),
    rpc.getRecentPerformanceSamples(60).catch(() => []),
    rpc.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_SIZE),
    rpc.getMinimumBalanceForRentExemption(STAKE_ACCOUNT_SIZE),
  ]);

  let slots = 0;
  let secs = 0;
  for (const s of samples) {
    if (s.numSlots > 0 && s.samplePeriodSecs > 0) {
      slots += s.numSlots;
      secs += s.samplePeriodSecs;
    }
  }
  let avgSlotSeconds = slots > 0 ? secs / slots : DEFAULT_SLOT_SECONDS;
  // Guard against garbage samples skewing APY estimates.
  if (!(avgSlotSeconds >= 0.3 && avgSlotSeconds <= 1.0)) avgSlotSeconds = DEFAULT_SLOT_SECONDS;
  const epochSeconds = Number(schedule.slotsPerEpoch) * avgSlotSeconds;

  return {
    genesisHash,
    clusterVerified: genesisHash === GENESIS_HASHES[policy.cluster],
    epoch: epochInfo.epoch,
    slotIndex: epochInfo.slotIndex,
    slotsInEpoch: epochInfo.slotsInEpoch,
    absoluteSlot: epochInfo.absoluteSlot,
    avgSlotSeconds,
    epochsPerYear: SECONDS_PER_YEAR / epochSeconds,
    rentTokenAccount,
    rentStakeAccount,
  };
}
