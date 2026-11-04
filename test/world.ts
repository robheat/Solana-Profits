// Shared scenario builder for tests: a mock chain with two verified pools and a 1 SOL wallet.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Keypair } from '@solana/web3.js';
import { toAddress, type Address } from '../src/crypto/keys.ts';
import { parsePolicy, parsePools, type Policy, type PoolConfig } from '../src/core/policy.ts';
import { loadChainContext, type ChainContext } from '../src/core/chain.ts';
import { evaluatePools, type PoolEvaluation } from '../src/core/pools.ts';
import { loadPortfolio, type Portfolio } from '../src/core/portfolio.ts';
import { BPF_UPGRADEABLE_LOADER_ID } from '../src/solana/constants.ts';
import { addressToBytes } from '../src/crypto/keys.ts';
import { concatBytes, u32le, u64le } from '../src/util/bytes.ts';
import { deterministicKeypair, makePoolFixture, newAddress, poolAccounts, poolConfigOf, type PoolFixture } from './fixtures.ts';
import { InProcessRpc, MockChain } from './mock-chain.ts';

export const REPO_ROOT = resolve(import.meta.dirname, '..');

export function defaultPolicyJson(): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, 'config/policy.json'), 'utf8')) as Record<string, unknown>;
}

export function policyWith(overrides: Record<string, unknown> = {}): Policy {
  return parsePolicy({ ...defaultPolicyJson(), ...overrides });
}

export interface Scenario {
  chain: MockChain;
  rpc: InProcessRpc;
  policy: Policy;
  jito: PoolFixture;
  blaze: PoolFixture;
  pools: PoolConfig[];
  walletKp: Keypair;
  wallet: Address;
}

export function scenario(opts: { walletLamports?: bigint; jito?: Partial<PoolFixture>; blaze?: Partial<PoolFixture>; policy?: Record<string, unknown> } = {}): Scenario {
  const chain = new MockChain();
  const jito = makePoolFixture({ lastUpdateEpoch: chain.epoch, ...opts.jito });
  // bSOL fixture yields a bit less (smaller last-epoch growth).
  const blaze = makePoolFixture({
    lastUpdateEpoch: chain.epoch,
    totalLamports: 1_000_000_000_000_000n,
    poolTokenSupply: 800_000_000_000_000n,
    lastEpochTotalLamports: 999_700_000_000_000n,
    lastEpochPoolTokenSupply: 800_000_000_000_000n,
    ...opts.blaze,
  });
  chain.addAccounts(poolAccounts(jito));
  chain.addAccounts(poolAccounts(blaze));
  // An upgradeable program account for SPoo1, last deployed long ago.
  const programData = newAddress();
  chain.setAccount('SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy', {
    lamports: 1_141_440n,
    owner: BPF_UPGRADEABLE_LOADER_ID,
    executable: true,
    data: concatBytes(u32le(2), addressToBytes(programData)),
  });
  chain.setAccount(programData, {
    lamports: 10_000_000n,
    owner: BPF_UPGRADEABLE_LOADER_ID,
    data: concatBytes(u32le(3), u64le(200_000_000n), Uint8Array.of(1), addressToBytes(newAddress()), new Uint8Array(100)),
  });
  const walletKp = deterministicKeypair(7);
  const wallet = toAddress(walletKp.publicKey.toBase58());
  chain.setWallet(wallet, opts.walletLamports ?? 1_000_000_000n);
  const policy = policyWith(opts.policy);
  const pools = parsePools([poolConfigOf(jito, 'JitoSOL'), poolConfigOf(blaze, 'bSOL')], policy);
  return { chain, rpc: new InProcessRpc(chain), policy, jito, blaze, pools, walletKp, wallet };
}

export async function load(s: Scenario): Promise<{ ctx: ChainContext; evaluations: PoolEvaluation[]; portfolio: Portfolio }> {
  const ctx = await loadChainContext(s.rpc, s.policy);
  const evaluations = await evaluatePools(s.rpc, s.pools, ctx, s.policy);
  const portfolio = await loadPortfolio(s.rpc, s.wallet, evaluations);
  return { ctx, evaluations, portfolio };
}

export function byCode(e: PoolEvaluation): Map<string, string> {
  return new Map(e.issues.map((i) => [i.code, i.level]));
}
