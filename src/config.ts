// Runtime configuration from environment variables + config/*.json.
//
//   SOLANA_RPC_URL        RPC endpoint (default: public mainnet-beta). Use a private
//                         provider URL for reliability; it is never printed in full.
//   WALLET_ADDRESS        Public address for read-only commands (status/plan/monitor).
//   SOLANA_KEYPAIR_PATH   Path to a solana-keygen JSON keypair (only for --execute).
//   SOLANA_KEYPAIR        Raw key material (JSON array or base58), e.g. from a secret store.
//   SOLPROFITS_POLICY     Override path to policy.json.
//   SOLPROFITS_POOLS      Override path to pools.json.
//   SOLPROFITS_LEDGER     Override path to the JSONL ledger (default data/ledger.jsonl).
//   SOLPROFITS_HALT=1     Kill switch: refuse to sign anything (same as creating ./HALT).

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { toAddress, type Address } from './crypto/keys.ts';
import { parsePolicy, parsePools, type Policy, type PoolConfig } from './core/policy.ts';

export const DEFAULT_RPC_URL = 'https://api.mainnet-beta.solana.com';

export interface AppConfig {
  repoRoot: string;
  rpcUrl: string;
  walletAddress: Address | null;
  policy: Policy;
  pools: PoolConfig[];
  ledgerPath: string;
  haltFile: string;
  isHalted(): boolean;
}

function readJson(path: string, what: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`could not read ${what} at ${path}: ${(e as Error).message}`);
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, repoRoot = resolve(import.meta.dirname, '..')): AppConfig {
  const policyPath = env.SOLPROFITS_POLICY ?? resolve(repoRoot, 'config/policy.json');
  const poolsPath = env.SOLPROFITS_POOLS ?? resolve(repoRoot, 'config/pools.json');
  const policy = parsePolicy(readJson(policyPath, 'policy'));
  const pools = parsePools(readJson(poolsPath, 'pool allowlist'), policy);
  const haltFile = resolve(repoRoot, 'HALT');
  const walletRaw = env.WALLET_ADDRESS?.trim();
  return {
    repoRoot,
    rpcUrl: env.SOLANA_RPC_URL?.trim() || DEFAULT_RPC_URL,
    walletAddress: walletRaw ? toAddress(walletRaw) : null,
    policy,
    pools,
    ledgerPath: env.SOLPROFITS_LEDGER ?? resolve(repoRoot, 'data/ledger.jsonl'),
    haltFile,
    isHalted: () => env.SOLPROFITS_HALT === '1' || existsSync(haltFile),
  };
}
