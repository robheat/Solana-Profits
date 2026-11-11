// Values what the other strategies hold (the USDC hedge and the memecoin bot's
// positions) so the staking tool's `status` and `monitor` see the whole wallet.
// Without this, a wallet that is deliberately hedged looks drained to the monitor.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Address } from '../crypto/keys.ts';
import { decodeTokenAccount } from '../solana/accounts.ts';
import { TOKEN_PROGRAM_ID } from '../solana/constants.ts';
import { deriveAssociatedTokenAddress } from '../solana/programs.ts';
import type { Rpc } from '../solana/rpc.ts';
import { DEFAULT_JUPITER_URL, JupiterClient, WSOL_MINT } from '../bot/jupiter.ts';
import type { BotState } from '../bot/state.ts';
import { parseRouterPolicy } from './policy.ts';

export interface OtherHolding {
  label: string;
  /** null when it is held but could not be valued. */
  valueLamports: bigint | null;
  detail: string;
}

export interface Quoter {
  quote(p: { inputMint: Address; outputMint: Address; amount: bigint; slippageBps: number }): Promise<{ outAmount: bigint }>;
}

export async function otherHoldings(p: {
  rpc: Rpc;
  wallet: Address;
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  /** Injectable for tests; defaults to the Jupiter API. */
  quoter?: Quoter;
}): Promise<OtherHolding[]> {
  const out: OtherHolding[] = [];
  const env = p.env;
  let hedge;
  try {
    hedge = parseRouterPolicy(JSON.parse(readFileSync(env.SOLPROFITS_ROUTER_POLICY ?? resolve(p.repoRoot, 'config/router-policy.json'), 'utf8'))).hedge;
  } catch {
    hedge = null;
  }
  if (hedge) {
    const acc = await p.rpc.getAccountInfo(deriveAssociatedTokenAddress(p.wallet, hedge.mint, TOKEN_PROGRAM_ID));
    const units = acc && acc.owner === TOKEN_PROGRAM_ID ? decodeTokenAccount(acc.data).amount : 0n;
    if (acc && units > 0n) {
      const amount = Number(units) / 10 ** hedge.decimals;
      let value: bigint | null = null;
      let why = '';
      try {
        const quoter = p.quoter ?? new JupiterClient(env.JUPITER_API_URL?.trim() || DEFAULT_JUPITER_URL, env.JUPITER_API_KEY?.trim() || undefined, { maxRetries: 1, timeoutMs: 8_000 });
        value = (await quoter.quote({ inputMint: hedge.mint, outputMint: WSOL_MINT, amount: units, slippageBps: hedge.slippageBps })).outAmount + acc.lamports;
      } catch (e) {
        why = ` (could not be valued: ${(e as Error).message})`;
      }
      out.push({ label: `${hedge.symbol} hedge`, valueLamports: value, detail: `${amount.toFixed(2)} ${hedge.symbol}${why}` });
    }
  }
  // Memecoin positions, from the bot's own state file when it lives on this machine.
  const statePath = resolve(env.SOLPROFITS_DATA_DIR ?? resolve(p.repoRoot, 'data'), 'bot-live-state.json');
  if (existsSync(statePath)) {
    try {
      const s = JSON.parse(readFileSync(statePath, 'utf8')) as BotState;
      if (s.wallet === p.wallet) {
        for (const pos of s.positions) out.push({ label: `${pos.symbol} (memecoin bot)`, valueLamports: BigInt(pos.lastValueLamports), detail: 'value at the bot\'s last check' });
      }
    } catch {
      // unreadable state: nothing to add
    }
  }
  return out;
}
