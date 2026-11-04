// On-chain token checks that no API can fake: who can mint more, who can freeze
// your balance, and whether Token-2022 extensions let someone take or lock your tokens.

import type { Address } from '../crypto/keys.ts';
import { decodeMint, type Mint } from '../solana/accounts.ts';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../solana/constants.ts';
import type { AccountInfo } from '../solana/rpc.ts';
import { readU16le } from '../util/bytes.ts';

/** spl-token-2022 ExtensionType numbering (extension/mod.rs). */
export const EXTENSION_NAMES: Record<number, string> = {
  0: 'Uninitialized',
  1: 'TransferFeeConfig',
  2: 'TransferFeeAmount',
  3: 'MintCloseAuthority',
  4: 'ConfidentialTransferMint',
  5: 'ConfidentialTransferAccount',
  6: 'DefaultAccountState',
  7: 'ImmutableOwner',
  8: 'MemoTransfer',
  9: 'NonTransferable',
  10: 'InterestBearingConfig',
  11: 'CpiGuard',
  12: 'PermanentDelegate',
  13: 'NonTransferableAccount',
  14: 'TransferHook',
  15: 'TransferHookAccount',
  16: 'ConfidentialTransferFeeConfig',
  17: 'ConfidentialTransferFeeAmount',
  18: 'MetadataPointer',
  19: 'TokenMetadata',
  20: 'GroupPointer',
  21: 'TokenGroup',
  22: 'GroupMemberPointer',
  23: 'TokenGroupMember',
  24: 'ConfidentialMintBurn',
  25: 'ScaledUiAmount',
  26: 'Pausable',
  27: 'PausableAccount',
};

/**
 * Mint extensions that cannot hurt a holder. Everything else is rejected — notably
 * TransferFeeConfig (silent tax), TransferHook (arbitrary code on every transfer),
 * PermanentDelegate (issuer can move your tokens), DefaultAccountState (frozen by
 * default), NonTransferable, Pausable, ScaledUiAmount/InterestBearing (balance games).
 */
export const BENIGN_MINT_EXTENSIONS = new Set([0, 3, 18, 19, 20, 21, 22, 23]);

const BASE_ACCOUNT_LENGTH = 165;
const ACCOUNT_TYPE_MINT = 1;
const MULTISIG_SIZE = 355;

export interface MintCheck {
  ok: boolean;
  reasons: string[];
  mint: Mint | null;
  tokenProgram: Address | null;
  extensions: string[];
}

export function parseMintExtensions(data: Uint8Array): number[] {
  if (data.length <= BASE_ACCOUNT_LENGTH) return [];
  if (data.length === MULTISIG_SIZE) throw new Error('account is a multisig, not a mint');
  if (data[BASE_ACCOUNT_LENGTH] !== ACCOUNT_TYPE_MINT) throw new Error('Token-2022 account type is not Mint');
  const types: number[] = [];
  let o = BASE_ACCOUNT_LENGTH + 1;
  while (o + 4 <= data.length) {
    const type = readU16le(data, o);
    const len = readU16le(data, o + 2);
    if (type === 0 && len === 0) break; // zero padding after the last entry
    if (o + 4 + len > data.length) throw new Error('truncated Token-2022 extension');
    types.push(type);
    o += 4 + len;
  }
  return types;
}

export function checkMintAccount(mintAddress: Address, account: AccountInfo | null): MintCheck {
  const reasons: string[] = [];
  if (!account) return { ok: false, reasons: [`mint ${mintAddress} does not exist`], mint: null, tokenProgram: null, extensions: [] };
  const tokenProgram = account.owner;
  if (tokenProgram !== TOKEN_PROGRAM_ID && tokenProgram !== TOKEN_2022_PROGRAM_ID) {
    return { ok: false, reasons: [`not an SPL token mint (owner ${tokenProgram})`], mint: null, tokenProgram, extensions: [] };
  }
  let mint: Mint;
  try {
    mint = decodeMint(account.data);
  } catch (e) {
    return { ok: false, reasons: [`mint does not decode: ${(e as Error).message}`], mint: null, tokenProgram, extensions: [] };
  }
  let extensions: number[] = [];
  if (tokenProgram === TOKEN_2022_PROGRAM_ID) {
    try {
      extensions = parseMintExtensions(account.data);
    } catch (e) {
      reasons.push(`Token-2022 extensions unreadable: ${(e as Error).message}`);
    }
    for (const t of extensions) {
      if (!BENIGN_MINT_EXTENSIONS.has(t)) reasons.push(`risky Token-2022 extension: ${EXTENSION_NAMES[t] ?? `unknown type ${t}`}`);
    }
  } else if (account.data.length !== 82) {
    reasons.push('classic mint with unexpected size');
  }
  if (!mint.isInitialized) reasons.push('mint is not initialized');
  if (mint.mintAuthority !== null) reasons.push(`mint authority still active (${mint.mintAuthority}): supply can be inflated`);
  if (mint.freezeAuthority !== null) reasons.push(`freeze authority active (${mint.freezeAuthority}): your tokens could be frozen`);
  if (mint.supply === 0n) reasons.push('zero supply');
  if (mint.decimals > 12) reasons.push(`unusual decimals (${mint.decimals})`);
  return { ok: reasons.length === 0, reasons, mint, tokenProgram, extensions: extensions.map((t) => EXTENSION_NAMES[t] ?? `type ${t}`) };
}
