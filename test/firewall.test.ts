// The transaction firewall must accept exactly what we intend and nothing else.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SystemProgram, PublicKey } from '@solana/web3.js';
import { inspectTransaction, type FirewallRules } from '../src/core/firewall.ts';
import { firewallRulesFor } from '../src/core/executor.ts';
import { buildDepositInstructions, buildWithdrawInstructions, planDeposit, planWithdraw, selectWithdrawPosition, type DepositPlan, type WithdrawPlan } from '../src/core/planner.ts';
import { compileLegacyMessage, type Instruction } from '../src/solana/tx.ts';
import { closeTokenAccount, createAssociatedTokenAccountIdempotent, deriveAssociatedTokenAddress, setComputeUnitLimit, setComputeUnitPrice } from '../src/solana/programs.ts';
import { TOKEN_PROGRAM_ID } from '../src/solana/constants.ts';
import { toAddress, type Address } from '../src/crypto/keys.ts';
import { encodeBase58 } from '../src/util/base58.ts';
import { encodeTokenAccount, newAddress } from './fixtures.ts';
import { load, scenario } from './world.ts';

const BLOCKHASH = encodeBase58(new Uint8Array(32).fill(9));
const COMPUTE = { unitLimit: 80_000, microLamportsPerUnit: 10_000n };

async function depositSetup() {
  const s = scenario();
  const w = await load(s);
  const plan = planDeposit({ portfolio: w.portfolio, evaluation: w.evaluations[0]!, policy: s.policy, rentTokenAccount: w.ctx.rentTokenAccount }) as DepositPlan;
  assert.equal(plan.kind, 'deposit');
  const rules: FirewallRules = firewallRulesFor({ rpc: s.rpc, policy: s.policy, evaluations: w.evaluations, log: () => {} }, s.wallet);
  return { s, plan, rules, w };
}

const check = (payer: Address, ixs: Instruction[], rules: FirewallRules) => inspectTransaction(compileLegacyMessage(payer, ixs, BLOCKHASH).bytes, rules);

test('the planned deposit passes and its actions are described from the bytes', async () => {
  const { s, plan, rules } = await depositSetup();
  const r = check(s.wallet, buildDepositInstructions(plan, COMPUTE, true), rules);
  assert.deepEqual(r.violations, []);
  assert.equal(r.ok, true);
  assert.equal(r.lamportsDeposited, plan.lamports);
  assert.equal(r.priorityFeeLamports, 800n);
  assert.match(r.actions.join('\n'), /deposit 987855720 lamports into JitoSOL/);
});

test('tampered deposits are rejected', async (t) => {
  const { s, plan, rules } = await depositSetup();
  const attacker = newAddress();
  const attackerAta = deriveAssociatedTokenAddress(attacker, plan.verified.pool.poolMint, TOKEN_PROGRAM_ID);
  const base = () => buildDepositInstructions(plan, COMPUTE, true);
  const depositIx = (ixs: Instruction[]) => ixs[ixs.length - 1]!;

  const cases: [string, () => Instruction[], RegExp][] = [
    ['pool tokens sent to an attacker account', () => {
      const ixs = base();
      depositIx(ixs).accounts[4] = { ...depositIx(ixs).accounts[4]!, address: attackerAta };
      return ixs;
    }, /account #4/],
    ['referral fee sent to an attacker account', () => {
      const ixs = base();
      depositIx(ixs).accounts[6] = { ...depositIx(ixs).accounts[6]!, address: attackerAta };
      return ixs;
    }, /account #6/],
    ['a hidden SOL transfer is appended', () => [
      ...base(),
      {
        programId: toAddress(SystemProgram.programId.toBase58()),
        accounts: [
          { address: s.wallet, isSigner: true, isWritable: true },
          { address: attacker, isSigner: false, isWritable: true },
        ],
        data: Uint8Array.from(SystemProgram.transfer({ fromPubkey: new PublicKey(s.wallet), toPubkey: new PublicKey(attacker), lamports: 1 }).data),
      },
    ], /not allowlisted/],
    ['priority fee above the cap', () => {
      const ixs = base();
      ixs[1] = setComputeUnitPrice(10_000_000_000n);
      return ixs;
    }, /priority fee/],
    ['no compute budget instructions', () => base().slice(2), /explicit compute unit limit/],
    ['duplicate compute budget instruction', () => [setComputeUnitLimit(1), ...base()], /duplicate/],
    ['legacy unguarded variant when policy requires the guard', () => buildDepositInstructions(plan, COMPUTE, false), /slippage-guarded/],
    ['token account created for someone else', () => {
      const ixs = base();
      ixs[2] = createAssociatedTokenAccountIdempotent({ payer: s.wallet, ata: attackerAta, owner: attacker, mint: plan.verified.pool.poolMint, tokenProgram: TOKEN_PROGRAM_ID });
      return ixs;
    }, /account #/],
    ['a stake pool that is not allowlisted', () => {
      const ixs = base();
      depositIx(ixs).accounts[0] = { ...depositIx(ixs).accounts[0]!, address: newAddress() };
      return ixs;
    }, /not allowlisted/],
    ['wrong reserve account', () => {
      const ixs = base();
      depositIx(ixs).accounts[2] = { ...depositIx(ixs).accounts[2]!, address: newAddress() };
      return ixs;
    }, /account #2/],
  ];
  for (const [name, make, expected] of cases) {
    await t.test(name, () => {
      const r = check(s.wallet, make(), rules);
      assert.equal(r.ok, false, `should be rejected: ${name}`);
      assert.match(r.violations.join('\n'), expected);
    });
  }

  await t.test('a second signer is rejected', () => {
    const other = newAddress();
    const ixs = base();
    depositIx(ixs).accounts.push({ address: other, isSigner: true, isWritable: false });
    const r = check(s.wallet, ixs, rules);
    assert.equal(r.ok, false);
    assert.match(r.violations.join('\n'), /exactly one signer/);
  });
  await t.test('a different fee payer is rejected', () => {
    const r = check(newAddress(), base(), rules);
    assert.equal(r.ok, false);
  });
  await t.test('deposit into a verified pool that policy currently blocks is rejected', () => {
    const blocked = { ...rules, depositAllowed: new Set<Address>() };
    const r = check(s.wallet, base(), blocked);
    assert.match(r.violations.join('\n'), /not currently allowed to receive deposits/);
  });
  await t.test('deposit larger than the per-transaction cap is rejected', () => {
    const r = check(s.wallet, buildDepositInstructions({ ...plan, lamports: 3_000_000_000n }, COMPUTE, true), rules);
    assert.match(r.violations.join('\n'), /maxSolPerTransaction/);
  });
});

test('withdrawals: legitimate full exit passes; redirected SOL or closed-account rent is rejected', async () => {
  const s = scenario();
  const ata = deriveAssociatedTokenAddress(s.wallet, s.jito.mint, TOKEN_PROGRAM_ID);
  s.chain.setAccount(ata, { lamports: 2_039_280n, owner: TOKEN_PROGRAM_ID, data: encodeTokenAccount({ mint: s.jito.mint, owner: s.wallet, amount: 789_000_000n }) });
  const w = await load(s);
  const plan = planWithdraw({ portfolio: w.portfolio, position: selectWithdrawPosition(w.portfolio) as never, policy: s.policy }) as WithdrawPlan;
  assert.equal(plan.kind, 'withdraw');
  const rules: FirewallRules = firewallRulesFor({ rpc: s.rpc, policy: s.policy, evaluations: w.evaluations, log: () => {} }, s.wallet);
  const ok = check(s.wallet, buildWithdrawInstructions(plan, COMPUTE, true), rules);
  assert.deepEqual(ok.violations, []);
  assert.equal(ok.poolTokensWithdrawn, 789_000_000n);

  const attacker = newAddress();
  const redirected = buildWithdrawInstructions(plan, COMPUTE, true);
  redirected[2]!.accounts[5] = { ...redirected[2]!.accounts[5]!, address: attacker };
  assert.match(check(s.wallet, redirected, rules).violations.join('\n'), /account #5/);

  const rent = buildWithdrawInstructions(plan, COMPUTE, true);
  rent[3] = closeTokenAccount({ account: ata, destination: attacker, owner: s.wallet, tokenProgram: TOKEN_PROGRAM_ID });
  assert.match(check(s.wallet, rent, rules).violations.join('\n'), /account #1/);
});
