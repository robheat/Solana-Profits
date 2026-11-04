// An in-memory mock of the Solana JSON-RPC surface this tool uses, with a small
// transaction executor for the handful of instructions we send. It decodes
// transactions with @solana/web3.js and pool accounts with @solana/spl-stake-pool,
// i.e. independently of src/, so end-to-end tests check our bytes against the
// official decoders. It is NOT the real stake pool program; the real program is
// exercised by `solprofits selfcheck` / simulation against mainnet.

import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { StakePoolLayout } from '@solana/spl-stake-pool';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { ed25519 } from '@noble/curves/ed25519.js';
import BN from 'bn.js';
import { Rpc, RpcError } from '../src/solana/rpc.ts';
import { toAddress, type Address } from '../src/crypto/keys.ts';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  COMPUTE_BUDGET_PROGRAM_ID,
  GENESIS_HASHES,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '../src/solana/constants.ts';
import { encodeBase58 } from '../src/util/base58.ts';
import { decodeMint, decodeTokenAccount } from '../src/solana/accounts.ts';
import { encodeMint, encodeTokenAccount, type RawAccount } from './fixtures.ts';

export class RpcFailure extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

type Accounts = Map<string, RawAccount>;

interface ExecResult {
  err: unknown;
  logs: string[];
  unitsConsumed: number;
  accounts: Accounts;
}

const clone = (m: Accounts): Accounts => new Map([...m].map(([k, v]) => [k, { ...v, data: Uint8Array.from(v.data) }]));
const u64 = (b: Uint8Array, o: number): bigint => new DataView(b.buffer, b.byteOffset + o, 8).getBigUint64(0, true);
const bn = (x: BN): bigint => BigInt(x.toString());
const ceilFee = (amount: bigint, f: { numerator: BN; denominator: BN }): bigint => {
  const d = bn(f.denominator);
  if (d === 0n) return 0n;
  return (amount * bn(f.numerator) + d - 1n) / d;
};

class InstructionFailure extends Error {
  readonly detail: unknown;
  constructor(detail: unknown) {
    super(JSON.stringify(detail));
    this.detail = detail;
  }
}

export class MockChain {
  accounts: Accounts = new Map();
  genesisHash: string = GENESIS_HASHES['mainnet-beta'];
  epoch = 800n;
  slotIndex = 100_000n;
  slotsInEpoch = 432_000n;
  slot = 345_700_000n;
  blockHeight = 320_000_000n;
  rentToken = 2_039_280n;
  rentStake = 2_282_880n;
  priorityFees: number[] = [0, 1_000, 5_000, 20_000];
  supportsGuarded = true;
  /** When > 0, sendTransaction accepts but the tx never lands and block height jumps past expiry. */
  dropTransactions = 0;
  statuses = new Map<string, { slot: number; err: unknown }>();
  sentSignatures: string[] = [];
  calls: string[] = [];
  private blockhashes = new Map<string, bigint>();

  setAccount(address: Address | string, account: RawAccount): void {
    this.accounts.set(address, account);
  }

  addAccounts(m: Map<Address, RawAccount>): void {
    for (const [k, v] of m) this.accounts.set(k, v);
  }

  setWallet(address: Address, lamports: bigint): void {
    this.accounts.set(address, { lamports, owner: SYSTEM_PROGRAM_ID, data: new Uint8Array(0) });
  }

  tokenBalance(ata: Address): bigint | null {
    const a = this.accounts.get(ata);
    return a ? decodeTokenAccount(a.data).amount : null;
  }

  // ------------------------------------------------------------ JSON-RPC

  handle(method: string, params: unknown[]): unknown {
    this.calls.push(method);
    const rpcAccount = (a: RawAccount | undefined) =>
      a ? { lamports: Number(a.lamports), owner: a.owner, executable: a.executable ?? false, rentEpoch: 0, space: a.data.length, data: [Buffer.from(a.data).toString('base64'), 'base64'] } : null;
    const ctx = { slot: Number(this.slot) };
    switch (method) {
      case 'getGenesisHash':
        return this.genesisHash;
      case 'getEpochInfo':
        return {
          epoch: Number(this.epoch),
          slotIndex: Number(this.slotIndex),
          slotsInEpoch: Number(this.slotsInEpoch),
          absoluteSlot: Number(this.slot),
          blockHeight: Number(this.blockHeight),
          transactionCount: 1,
        };
      case 'getEpochSchedule':
        return { slotsPerEpoch: 432_000, leaderScheduleSlotOffset: 432_000, warmup: false, firstNormalEpoch: 0, firstNormalSlot: 0 };
      case 'getRecentPerformanceSamples':
        return Array.from({ length: 10 }, () => ({ slot: 1, numSlots: 150, numTransactions: 1, samplePeriodSecs: 60 }));
      case 'getMinimumBalanceForRentExemption':
        return Number(params[0] === 200 ? this.rentStake : params[0] === 165 ? this.rentToken : 1_000_000n);
      case 'getRecentPrioritizationFees':
        return this.priorityFees.map((f, i) => ({ slot: i, prioritizationFee: f }));
      case 'getAccountInfo':
        return { context: ctx, value: rpcAccount(this.accounts.get(String(params[0]))) };
      case 'getMultipleAccounts':
        return { context: ctx, value: (params[0] as string[]).map((a) => rpcAccount(this.accounts.get(a))) };
      case 'getBalance':
        return { context: ctx, value: Number(this.accounts.get(String(params[0]))?.lamports ?? 0n) };
      case 'getLatestBlockhash': {
        const blockhash = encodeBase58(new Uint8Array(randomBytes(32)));
        const lastValidBlockHeight = this.blockHeight + 150n;
        this.blockhashes.set(blockhash, lastValidBlockHeight);
        return { context: ctx, value: { blockhash, lastValidBlockHeight: Number(lastValidBlockHeight) } };
      }
      case 'getBlockHeight':
        this.blockHeight += 1n;
        return Number(this.blockHeight);
      case 'simulateTransaction': {
        const cfg = (params[1] ?? {}) as { sigVerify?: boolean; accounts?: { addresses: string[] } };
        const bytes = Buffer.from(String(params[0]), 'base64');
        const res = this.execute(bytes, { verifySignatures: cfg.sigVerify === true, checkBlockhash: false });
        return {
          context: ctx,
          value: {
            err: res.err,
            logs: res.logs,
            unitsConsumed: res.unitsConsumed,
            accounts: res.err ? null : (cfg.accounts?.addresses ?? []).map((a) => rpcAccount(res.accounts.get(a))),
          },
        };
      }
      case 'sendTransaction': {
        const bytes = Buffer.from(String(params[0]), 'base64');
        const tx = VersionedTransaction.deserialize(bytes);
        const signature = encodeBase58(tx.signatures[0]!);
        if (this.statuses.has(signature)) throw new RpcFailure(-32002, 'Transaction simulation failed: This transaction has already been processed');
        const res = this.execute(bytes, { verifySignatures: true, checkBlockhash: true });
        if (res.err) throw new RpcFailure(-32002, 'Transaction simulation failed', { err: res.err, logs: res.logs });
        this.sentSignatures.push(signature);
        if (this.dropTransactions > 0) {
          this.dropTransactions -= 1;
          this.blockHeight += 1_000n; // the blockhash expires before it lands
          return signature;
        }
        this.accounts = res.accounts;
        this.slot += 1n;
        this.statuses.set(signature, { slot: Number(this.slot), err: null });
        return signature;
      }
      case 'getSignatureStatuses': {
        const sigs = params[0] as string[];
        return {
          context: ctx,
          value: sigs.map((s) => {
            const st = this.statuses.get(s);
            return st ? { slot: st.slot, confirmations: 1, err: st.err, confirmationStatus: 'confirmed' } : null;
          }),
        };
      }
      default:
        throw new RpcFailure(-32601, `Method not found: ${method}`);
    }
  }

  // ------------------------------------------------------------ executor

  execute(bytes: Uint8Array, opts: { verifySignatures: boolean; checkBlockhash: boolean }): ExecResult {
    const tx = VersionedTransaction.deserialize(bytes);
    const msg = tx.message;
    const keys = msg.staticAccountKeys.map((k) => k.toBase58());
    const logs: string[] = [];
    const state = clone(this.accounts);
    if (opts.checkBlockhash) {
      const lvbh = this.blockhashes.get(msg.recentBlockhash);
      if (lvbh === undefined || this.blockHeight > lvbh) return { err: 'BlockhashNotFound', logs, unitsConsumed: 0, accounts: state };
    }
    if (opts.verifySignatures) {
      const messageBytes = msg.serialize();
      for (let i = 0; i < msg.header.numRequiredSignatures; i++) {
        if (!ed25519.verify(tx.signatures[i]!, messageBytes, new PublicKey(keys[i]!).toBytes())) {
          return { err: 'SignatureFailure', logs, unitsConsumed: 0, accounts: state };
        }
      }
    }
    // Fees
    let unitLimit = 200_000n;
    let unitPrice = 0n;
    for (const ix of msg.compiledInstructions) {
      if (keys[ix.programIdIndex] === COMPUTE_BUDGET_PROGRAM_ID) {
        const d = ix.data;
        if (d[0] === 2) unitLimit = BigInt(new DataView(d.buffer, d.byteOffset + 1, 4).getUint32(0, true));
        if (d[0] === 3) unitPrice = u64(d, 1);
      }
    }
    const fee = 5_000n * BigInt(msg.header.numRequiredSignatures) + (unitLimit * unitPrice + 999_999n) / 1_000_000n;
    const payer = state.get(keys[0]!);
    if (!payer || payer.lamports < fee) return { err: 'InsufficientFundsForFee', logs, unitsConsumed: 0, accounts: state };
    payer.lamports -= fee;

    let units = 0;
    try {
      msg.compiledInstructions.forEach((ix, index) => {
        const program = keys[ix.programIdIndex]!;
        const accs = ix.accountKeyIndexes.map((i) => keys[i]!);
        const fail = (inner: unknown): never => {
          throw new InstructionFailure({ InstructionError: [index, inner] });
        };
        logs.push(`Program ${program} invoke [1]`);
        if (program === COMPUTE_BUDGET_PROGRAM_ID) {
          units += 150;
        } else if (program === ASSOCIATED_TOKEN_PROGRAM_ID) {
          units += 25_000;
          this.createAta(state, accs, fail);
        } else if (program === TOKEN_PROGRAM_ID) {
          units += 3_000;
          this.closeAccount(state, accs, index, fail, keys);
        } else if (program === 'SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy') {
          units += 40_000;
          this.stakePoolIx(state, program, accs, ix.data, fail);
        } else {
          fail('UnsupportedProgramId');
        }
        logs.push(`Program ${program} success`);
      });
    } catch (e) {
      if (e instanceof InstructionFailure) {
        logs.push(`failed: ${e.message}`);
        return { err: e.detail, logs, unitsConsumed: units, accounts: this.accounts };
      }
      throw e;
    }
    if (BigInt(units) > unitLimit) return { err: { InstructionError: [0, 'ComputationalBudgetExceeded'] }, logs, unitsConsumed: units, accounts: this.accounts };
    return { err: null, logs, unitsConsumed: units, accounts: state };
  }

  private createAta(state: Accounts, accs: string[], fail: (e: unknown) => never): void {
    const [payer, ata, owner, mint, system, tokenProgram] = accs;
    if (system !== SYSTEM_PROGRAM_ID || tokenProgram !== TOKEN_PROGRAM_ID) fail('IncorrectProgramId');
    const expected = getAssociatedTokenAddressSync(new PublicKey(mint!), new PublicKey(owner!)).toBase58();
    if (ata !== expected) fail('InvalidSeeds');
    if (state.has(ata!)) return; // idempotent
    const p = state.get(payer!)!;
    if (p.lamports < this.rentToken) fail({ Custom: 1 });
    p.lamports -= this.rentToken;
    state.set(ata!, { lamports: this.rentToken, owner: TOKEN_PROGRAM_ID, data: encodeTokenAccount({ mint: toAddress(mint!), owner: toAddress(owner!), amount: 0n }) });
  }

  private closeAccount(state: Accounts, accs: string[], _index: number, fail: (e: unknown) => never, _keys: string[]): void {
    const [account, destination, owner] = accs;
    const a = state.get(account!);
    if (!a) fail('UninitializedAccount');
    const t = decodeTokenAccount(a!.data);
    if (t.owner !== owner) fail({ Custom: 4 }); // OwnerMismatch
    if (t.amount !== 0n) fail({ Custom: 11 }); // NonNativeHasBalance
    state.get(destination!)!.lamports += a!.lamports;
    state.delete(account!);
  }

  private adjustToken(state: Accounts, address: string, mint: string, delta: bigint, fail: (e: unknown) => never): void {
    const a = state.get(address);
    if (!a || a.owner !== TOKEN_PROGRAM_ID) fail('InvalidAccountData');
    const t = decodeTokenAccount(a!.data);
    if (t.mint !== mint) fail({ Custom: 3 }); // MintMismatch
    if (t.amount + delta < 0n) fail({ Custom: 1 }); // InsufficientFunds
    a!.data = encodeTokenAccount({ mint: t.mint, owner: t.owner, amount: t.amount + delta, delegate: t.delegate, delegatedAmount: t.delegatedAmount, closeAuthority: t.closeAuthority });
  }

  private adjustSupply(state: Accounts, mint: string, delta: bigint): void {
    const a = state.get(mint)!;
    const m = decodeMint(a.data);
    a.data = encodeMint({ mintAuthority: m.mintAuthority, supply: m.supply + delta, decimals: m.decimals, freezeAuthority: m.freezeAuthority });
  }

  private stakePoolIx(state: Accounts, program: string, accs: string[], data: Uint8Array, fail: (e: unknown) => never): void {
    const tag = data[0];
    if ((tag === 25 || tag === 26) && !this.supportsGuarded) fail('InvalidInstructionData');
    const poolAcc = state.get(accs[0]!);
    if (!poolAcc || poolAcc.owner !== program) fail('IncorrectProgramId');
    const pool = StakePoolLayout.decode(Buffer.from(poolAcc!.data));
    const withdrawAuthority = PublicKey.findProgramAddressSync([new PublicKey(accs[0]!).toBuffer(), Buffer.from('withdraw')], new PublicKey(program))[0].toBase58();
    if (accs[1] !== withdrawAuthority) fail({ Custom: 1 }); // InvalidProgramAddress
    if (BigInt(pool.lastUpdateEpoch.toString()) < this.epoch) fail({ Custom: 17 }); // StakeListAndPoolOutOfDate
    const total = bn(pool.totalLamports);
    const supply = bn(pool.poolTokenSupply);
    const mint = pool.poolMint.toBase58();

    if (tag === 14 || tag === 25) {
      const [, , reserve, from, dest, managerFee, referrer, poolMint, system, tokenProgram] = accs;
      if (reserve !== pool.reserveStake.toBase58()) fail({ Custom: 15 });
      if (poolMint !== mint) fail({ Custom: 10 });
      if (managerFee !== pool.managerFeeAccount.toBase58()) fail({ Custom: 9 });
      if (system !== SYSTEM_PROGRAM_ID || tokenProgram !== pool.tokenProgramId.toBase58()) fail('IncorrectProgramId');
      if (pool.solDepositAuthority && accs.length < 11) fail({ Custom: 7 });
      const lamports = u64(data, 1);
      const minOut = tag === 25 ? u64(data, 9) : null;
      const newTokens = total === 0n || supply === 0n ? lamports : (lamports * supply) / total;
      const depositFee = ceilFee(newTokens, pool.solDepositFee);
      const user = newTokens - depositFee;
      const referral = (depositFee * BigInt(pool.solReferralFee)) / 100n;
      const managerTokens = depositFee - referral;
      if (user === 0n) fail({ Custom: 29 });
      if (minOut !== null && user < minOut) fail({ Custom: 39 });
      const payer = state.get(from!)!;
      if (payer.lamports < lamports) fail({ Custom: 1 });
      payer.lamports -= lamports;
      state.get(reserve!)!.lamports += lamports;
      this.adjustToken(state, dest!, mint, user, fail);
      if (managerTokens > 0n) this.adjustToken(state, managerFee!, mint, managerTokens, fail);
      if (referral > 0n) this.adjustToken(state, referrer!, mint, referral, fail);
      this.adjustSupply(state, mint, newTokens);
      pool.poolTokenSupply = new BN((supply + newTokens).toString());
      pool.totalLamports = new BN((total + lamports).toString());
    } else if (tag === 16 || tag === 26) {
      const [, , authority, source, reserve, destination, managerFee, poolMint] = accs;
      if (reserve !== pool.reserveStake.toBase58()) fail({ Custom: 15 });
      if (poolMint !== mint) fail({ Custom: 10 });
      if (managerFee !== pool.managerFeeAccount.toBase58()) fail({ Custom: 9 });
      const src = decodeTokenAccount(state.get(source!)!.data);
      if (src.owner !== authority) fail({ Custom: 4 });
      const tokens = u64(data, 1);
      const minOut = tag === 26 ? u64(data, 9) : null;
      const feeTokens = ceilFee(tokens, pool.solWithdrawalFee);
      const burned = tokens - feeTokens;
      const num = burned * total;
      const lamportsOut = num < supply || supply === 0n ? 0n : num / supply;
      if (lamportsOut === 0n) fail({ Custom: 28 });
      if (minOut !== null && lamportsOut < minOut) fail({ Custom: 39 });
      const reserveAcc = state.get(reserve!)!;
      if (reserveAcc.lamports - lamportsOut < this.rentStake) fail({ Custom: 35 });
      this.adjustToken(state, source!, mint, -tokens, fail);
      if (feeTokens > 0n) this.adjustToken(state, managerFee!, mint, feeTokens, fail);
      this.adjustSupply(state, mint, -burned);
      reserveAcc.lamports -= lamportsOut;
      state.get(destination!)!.lamports += lamportsOut;
      pool.poolTokenSupply = new BN((supply - burned).toString());
      pool.totalLamports = new BN((total - lamportsOut).toString());
    } else {
      fail('InvalidInstructionData');
    }
    // Re-encode the pool exactly like the fixture does (None as null; see fixtures.ts).
    const buf = Buffer.alloc(poolAcc!.data.length);
    const asNull = (v: unknown) => (v === undefined ? null : v);
    StakePoolLayout.encode(
      {
        ...pool,
        nextEpochFee: asNull(pool.nextEpochFee),
        preferredDepositValidatorVoteAddress: asNull(pool.preferredDepositValidatorVoteAddress),
        preferredWithdrawValidatorVoteAddress: asNull(pool.preferredWithdrawValidatorVoteAddress),
        nextStakeWithdrawalFee: asNull(pool.nextStakeWithdrawalFee),
        solDepositAuthority: asNull(pool.solDepositAuthority),
        solWithdrawAuthority: asNull(pool.solWithdrawAuthority),
        nextSolWithdrawalFee: asNull(pool.nextSolWithdrawalFee),
      } as unknown as Parameters<typeof StakePoolLayout.encode>[0],
      buf,
    );
    poolAcc!.data = new Uint8Array(buf);
  }
}

/** Rpc client wired directly to a MockChain (no HTTP), for in-process tests. */
export class InProcessRpc extends Rpc {
  readonly chain: MockChain;
  constructor(chain: MockChain) {
    super('http://localhost:1', { maxRetries: 0, sleep: async () => {} });
    this.chain = chain;
  }
  override async call<T>(method: string, params: unknown[] = []): Promise<T> {
    try {
      // JSON round trip so values look exactly like they would on the wire.
      return JSON.parse(JSON.stringify(this.chain.handle(method, params))) as T;
    } catch (e) {
      if (e instanceof RpcFailure) throw new RpcError(`${method}: ${e.message}`, e.code, e.data);
      throw e;
    }
  }
}

/** Serves a MockChain over HTTP JSON-RPC on 127.0.0.1 for CLI end-to-end tests. */
export async function serveMockChain(chain: MockChain): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let id: unknown = null;
      try {
        const reqJson = JSON.parse(body) as { id: unknown; method: string; params?: unknown[] };
        id = reqJson.id;
        const result = chain.handle(reqJson.method, reqJson.params ?? []);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
      } catch (e) {
        const f = e instanceof RpcFailure ? e : new RpcFailure(-32603, (e as Error).message);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: f.code, message: f.message, data: f.data } }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no server address');
  return { url: `http://127.0.0.1:${address.port}`, server };
}
