// prepare -> sign -> send -> confirm against the mock chain, including failure paths.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionError, prepare, signAndSend, type ExecContext } from '../src/core/executor.ts';
import { planDeposit, planWithdraw, selectWithdrawPosition, type DepositPlan, type WithdrawPlan } from '../src/core/planner.ts';
import { signerFromSecretKey } from '../src/crypto/keys.ts';
import { deriveAssociatedTokenAddress } from '../src/solana/programs.ts';
import { TOKEN_PROGRAM_ID } from '../src/solana/constants.ts';
import { encodeStakePool, deterministicKeypair } from './fixtures.ts';
import { load, scenario, type Scenario } from './world.ts';

const quiet = { log: () => {}, sleep: async () => {} };

async function depositFlow(s: Scenario) {
  const w = await load(s);
  const plan = planDeposit({ portfolio: w.portfolio, evaluation: w.evaluations[0]!, policy: s.policy, rentTokenAccount: w.ctx.rentTokenAccount }) as DepositPlan;
  assert.equal(plan.kind, 'deposit');
  const ctx: ExecContext = { rpc: s.rpc, policy: s.policy, evaluations: w.evaluations, ...quiet };
  return { w, plan, ctx };
}

test('deposit: prepare simulates and verifies, then sign+send lands exactly the predicted amounts', async () => {
  const s = scenario();
  const { plan, ctx } = await depositFlow(s);
  const prepared = await prepare(ctx, plan);
  assert.equal(prepared.guarded, true);
  assert.ok(prepared.compute.unitLimit >= 20_000 && prepared.compute.unitLimit < 200_000, `tuned limit ${prepared.compute.unitLimit}`);
  assert.equal(prepared.checks.length, 2);

  const outcome = await signAndSend(ctx, prepared, signerFromSecretKey(s.walletKp.secretKey), () => false);
  assert.equal(outcome.status, 'confirmed');
  const ata = deriveAssociatedTokenAddress(s.wallet, s.jito.mint, TOKEN_PROGRAM_ID);
  assert.equal(s.chain.tokenBalance(ata), plan.receivedTokens);
  const fee = 5_000n + (BigInt(prepared.compute.unitLimit) * prepared.compute.microLamportsPerUnit + 999_999n) / 1_000_000n;
  assert.equal(s.chain.accounts.get(s.wallet)!.lamports, 1_000_000_000n - plan.lamports - plan.ataRentLamports - fee);
  assert.ok(s.chain.accounts.get(s.wallet)!.lamports >= s.policy.reserveLamports, 'fee reserve intact');
});

test('then a full withdrawal returns the SOL and closes the token account', async () => {
  const s = scenario();
  const first = await depositFlow(s);
  await signAndSend(first.ctx, await prepare(first.ctx, first.plan), signerFromSecretKey(s.walletKp.secretKey), () => false);

  const w = await load(s);
  const pos = selectWithdrawPosition(w.portfolio);
  const plan = planWithdraw({ portfolio: w.portfolio, position: pos as never, policy: s.policy }) as WithdrawPlan;
  assert.equal(plan.kind, 'withdraw');
  const ctx: ExecContext = { rpc: s.rpc, policy: s.policy, evaluations: w.evaluations, ...quiet };
  const before = s.chain.accounts.get(s.wallet)!.lamports;
  const prepared = await prepare(ctx, plan);
  const outcome = await signAndSend(ctx, prepared, signerFromSecretKey(s.walletKp.secretKey), () => false);
  assert.equal(outcome.status, 'confirmed');
  const after = s.chain.accounts.get(s.wallet)!.lamports;
  const fee = 5_000n + (BigInt(prepared.compute.unitLimit) * prepared.compute.microLamportsPerUnit + 999_999n) / 1_000_000n;
  assert.equal(after - before, plan.quote.lamportsOut + plan.ataRentLamports - fee);
  assert.equal(s.chain.accounts.has(plan.ata), false, 'token account closed');
  // Round trip cost: only the pool's 0.1% instant-exit fee, rounding and tx fees.
  assert.ok(1_000_000_000n - after < 1_200_000n, `round trip lost ${1_000_000_000n - after} lamports`);
});

test('kill switch and wrong key both refuse to sign', async () => {
  const s = scenario();
  const { plan, ctx } = await depositFlow(s);
  const prepared = await prepare(ctx, plan);
  await assert.rejects(signAndSend(ctx, prepared, signerFromSecretKey(s.walletKp.secretKey), () => true), /kill switch/);
  await assert.rejects(signAndSend(ctx, prepared, signerFromSecretKey(deterministicKeypair(99).secretKey), () => false), /does not match/);
  assert.equal(s.chain.sentSignatures.length, 0);
});

test('a program without the slippage-guarded instruction is refused unless policy allows the fallback', async () => {
  const s = scenario();
  s.chain.supportsGuarded = false;
  const { plan, ctx } = await depositFlow(s);
  await assert.rejects(prepare(ctx, plan), /does not accept the slippage-guarded instruction/);

  const lenient = scenario({ policy: { requireSlippageGuardedInstructions: false } });
  lenient.chain.supportsGuarded = false;
  const f = await depositFlow(lenient);
  const prepared = await prepare(f.ctx, f.plan);
  assert.equal(prepared.guarded, false);
});

test('epoch rollover before the pool crank: simulation fails with an actionable hint and nothing is signed', async () => {
  const s = scenario();
  const { plan, ctx } = await depositFlow(s);
  s.chain.epoch += 1n;
  await assert.rejects(prepare(ctx, plan), (e: unknown) => e instanceof ExecutionError && /StakeListAndPoolOutOfDate/.test(e.message) && /retry/.test(e.message));
});

test('pool state drifting after planning is caught by two independent layers', async (t) => {
  await t.test('large drift: the program itself reverts (on-chain minimum output)', async () => {
    const s = scenario();
    const { plan, ctx } = await depositFlow(s);
    // Rate jumps 1% between planning and execution: below the program-enforced minimum (20 bps tolerance).
    s.chain.accounts.get(s.jito.stakePool)!.data = encodeStakePool({ ...s.jito, totalLamports: (s.jito.totalLamports * 101n) / 100n });
    await assert.rejects(prepare(ctx, plan), /ExceededSlippage/);
  });
  await t.test('small drift inside the on-chain tolerance: the simulated-balance check refuses (1 bps)', async () => {
    const s = scenario();
    const { plan, ctx } = await depositFlow(s);
    // 5 bps drift: the program would accept it, our exact-quote verification does not.
    s.chain.accounts.get(s.jito.stakePool)!.data = encodeStakePool({ ...s.jito, totalLamports: (s.jito.totalLamports * 10_005n) / 10_000n });
    await assert.rejects(prepare(ctx, plan), /pool state changed/);
  });
});

test('an expired transaction is reported as expired (safe to re-plan), not as success', async () => {
  const s = scenario();
  const { plan, ctx } = await depositFlow(s);
  const prepared = await prepare(ctx, plan);
  s.chain.dropTransactions = 1;
  const outcome = await signAndSend(ctx, prepared, signerFromSecretKey(s.walletKp.secretKey), () => false);
  assert.equal(outcome.status, 'expired');
  assert.equal(s.chain.accounts.get(s.wallet)!.lamports, 1_000_000_000n, 'nothing moved');
});
