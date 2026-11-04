// Pool verification, portfolio valuation and planning rules.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeMint, encodeTokenAccount, encodeStakePool, newAddress } from './fixtures.ts';
import { byCode, load, scenario } from './world.ts';
import { inspectPrograms, rankPools } from '../src/core/pools.ts';
import { planDeposit, planWithdraw, selectDepositPool, selectWithdrawPosition } from '../src/core/planner.ts';
import { deriveAssociatedTokenAddress } from '../src/solana/programs.ts';
import { TOKEN_PROGRAM_ID } from '../src/solana/constants.ts';
import { quoteDepositSol } from '../src/core/math.ts';
import { addressToBytes } from '../src/crypto/keys.ts';
import { concatBytes, u32le, u64le } from '../src/util/bytes.ts';

test('a well-formed pool verifies, is depositable and gets a sane APY estimate', async () => {
  const s = scenario();
  const { evaluations, ctx } = await load(s);
  const jito = evaluations.find((e) => e.config.symbol === 'JitoSOL')!;
  assert.ok(jito.verified, JSON.stringify(jito.issues));
  assert.equal(jito.depositable, true);
  assert.equal(jito.withdrawable, true);
  assert.deepEqual(jito.issues.filter((i) => i.level !== 'info'), []);
  const apy = jito.metrics!.apyEstimate!;
  assert.ok(apy > 0.06 && apy < 0.08, `apy ${apy}`);
  assert.ok(Math.abs(ctx.epochsPerYear - 365.25 * 86400 / (432_000 * 0.4)) < 0.01);
  assert.equal(jito.metrics!.epochFeePct, 4);
  assert.equal(jito.metrics!.solWithdrawalFeeBps, 10);
});

test('identity failures exclude a pool entirely', async (t) => {
  await t.test('owned by an unexpected program', async () => {
    const s = scenario();
    s.chain.accounts.get(s.jito.stakePool)!.owner = newAddress();
    const e = (await load(s)).evaluations[0]!;
    assert.equal(e.verified, null);
    assert.equal(byCode(e).get('pool-owner'), 'critical');
  });
  await t.test('config mint does not match the pool', async () => {
    const s = scenario();
    s.pools[0] = { ...s.pools[0]!, mint: newAddress() };
    const e = (await load(s)).evaluations[0]!;
    assert.equal(byCode(e).get('pool-mint'), 'critical');
  });
  await t.test('mint authority is not the withdraw authority PDA', async () => {
    const s = scenario();
    s.chain.accounts.get(s.jito.mint)!.data = encodeMint({ mintAuthority: newAddress(), supply: s.jito.poolTokenSupply });
    const e = (await load(s)).evaluations[0]!;
    assert.equal(byCode(e).get('mint-authority'), 'critical');
  });
  await t.test('mint has a freeze authority', async () => {
    const s = scenario();
    s.chain.accounts.get(s.jito.mint)!.data = encodeMint({ mintAuthority: s.jito.withdrawAuthority, supply: s.jito.poolTokenSupply, freezeAuthority: newAddress() });
    const e = (await load(s)).evaluations[0]!;
    assert.equal(byCode(e).get('mint-freeze'), 'critical');
  });
  await t.test('bump seed mismatch (layout misread or spoofed account)', async () => {
    const s = scenario();
    s.chain.accounts.get(s.jito.stakePool)!.data = encodeStakePool({ ...s.jito, bump: (s.jito.bump + 1) % 256 });
    const e = (await load(s)).evaluations[0]!;
    assert.equal(byCode(e).get('pool-bump'), 'critical');
  });
  await t.test('mint supply above recorded pool supply', async () => {
    const s = scenario();
    s.chain.accounts.get(s.jito.mint)!.data = encodeMint({ mintAuthority: s.jito.withdrawAuthority, supply: s.jito.poolTokenSupply + 1n });
    const e = (await load(s)).evaluations[0]!;
    assert.equal(byCode(e).get('supply-mismatch'), 'critical');
  });
  await t.test('tokens burned outside the pool are only informational', async () => {
    const s = scenario();
    s.chain.accounts.get(s.jito.mint)!.data = encodeMint({ mintAuthority: s.jito.withdrawAuthority, supply: s.jito.poolTokenSupply - 5n });
    const e = (await load(s)).evaluations[0]!;
    assert.equal(byCode(e).get('supply-burned'), 'info');
    assert.equal(e.depositable, true);
  });
  await t.test('reserve is not a stake account', async () => {
    const s = scenario();
    s.chain.accounts.get(s.jito.reserveStake)!.owner = newAddress();
    const e = (await load(s)).evaluations[0]!;
    assert.equal(byCode(e).get('reserve-invalid'), 'critical');
    assert.equal(e.withdrawable, false);
  });
});

test('policy checks: staleness, fees, pending fee hikes, gated exits, value drops', async (t) => {
  const cases: { name: string; jito: Parameters<typeof scenario>[0]; code: string; level: string; deposit: boolean; withdraw: boolean }[] = [
    { name: 'pool one epoch behind', jito: { jito: { lastUpdateEpoch: 799n } }, code: 'pool-stale', level: 'warning', deposit: false, withdraw: false },
    { name: 'pool two epochs behind', jito: { jito: { lastUpdateEpoch: 798n } }, code: 'pool-stale', level: 'critical', deposit: false, withdraw: false },
    { name: 'reward fee above max', jito: { jito: { epochFee: { numerator: 15n, denominator: 100n } } }, code: 'epoch-fee', level: 'warning', deposit: false, withdraw: true },
    { name: 'pending reward fee hike above max', jito: { jito: { nextEpochFee: { numerator: 50n, denominator: 100n } } }, code: 'epoch-fee-increase', level: 'critical', deposit: false, withdraw: true },
    { name: 'pending small reward fee hike', jito: { jito: { nextEpochFee: { numerator: 6n, denominator: 100n } } }, code: 'epoch-fee-increase', level: 'warning', deposit: true, withdraw: true },
    { name: 'deposit fee above max', jito: { jito: { solDepositFee: { numerator: 5n, denominator: 1000n } } }, code: 'deposit-fee', level: 'warning', deposit: false, withdraw: true },
    { name: 'exit fee above max', jito: { jito: { solWithdrawalFee: { numerator: 1n, denominator: 100n } } }, code: 'withdrawal-fee', level: 'warning', deposit: false, withdraw: true },
    { name: 'pending exit fee hike above max', jito: { jito: { nextSolWithdrawalFee: { numerator: 2n, denominator: 100n } } }, code: 'withdrawal-fee-increase', level: 'critical', deposit: false, withdraw: true },
    { name: 'SOL withdrawals gated by an authority', jito: { jito: { solWithdrawAuthority: newAddress() } }, code: 'withdraw-gated', level: 'warning', deposit: false, withdraw: false },
    { name: 'SOL deposits gated by an authority', jito: { jito: { solDepositAuthority: newAddress() } }, code: 'deposit-gated', level: 'info', deposit: false, withdraw: true },
    { name: 'pool token value decreased', jito: { jito: { lastEpochTotalLamports: 12_100_000_000_000_000n } }, code: 'value-decreased', level: 'critical', deposit: false, withdraw: true },
    { name: 'pool too small', jito: { jito: { totalLamports: 50_000_000_000_000n, poolTokenSupply: 40_000_000_000_000n, lastEpochTotalLamports: 49_980_000_000_000n, lastEpochPoolTokenSupply: 40_000_000_000_000n } }, code: 'pool-small', level: 'warning', deposit: false, withdraw: true },
  ];
  for (const c of cases) {
    await t.test(c.name, async () => {
      const s = scenario(c.jito);
      const e = (await load(s)).evaluations[0]!;
      assert.ok(e.verified, 'still verified');
      assert.equal(byCode(e).get(c.code), c.level, JSON.stringify(e.issues));
      assert.equal(e.depositable, c.deposit, 'depositable');
      assert.equal(e.withdrawable, c.withdraw, 'withdrawable');
    });
  }
});

test('implausible APY is flagged and capped in the score', async () => {
  const s = scenario({ jito: { lastEpochTotalLamports: 11_900_000_000_000_000n } });
  const e = (await load(s)).evaluations[0]!;
  assert.equal(byCode(e).get('apy-anomaly'), 'info');
  assert.ok(e.metrics!.score! <= s.policy.aprSanityMaxPct / 100);
});

test('ranking prefers the depositable pool with the better score', async () => {
  const s = scenario();
  const { evaluations } = await load(s);
  assert.deepEqual(rankPools(evaluations).map((e) => e.config.symbol), ['JitoSOL', 'bSOL']);
  const s2 = scenario({ jito: { solDepositFee: { numerator: 5n, denominator: 1000n } } });
  const r2 = rankPools((await load(s2)).evaluations);
  assert.equal(r2[0]!.config.symbol, 'bSOL', 'non-depositable pools rank last');
});

test('program upgrade within ~2 epochs raises a warning', async () => {
  const s = scenario();
  const { ctx } = await load(s);
  const programAcc = s.chain.accounts.get('SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy')!;
  const pdAddr = (await import('../src/solana/accounts.ts')).decodeUpgradeableProgram(programAcc.data);
  s.chain.accounts.get(pdAddr)!.data = concatBytes(u32le(3), u64le(ctx.absoluteSlot - 1000n), Uint8Array.of(1), addressToBytes(newAddress()));
  const [status] = await inspectPrograms(s.rpc, [s.pools[0]!.program], ctx);
  assert.equal(status!.issues[0]?.code, 'program-upgraded');
});

test('portfolio values positions in SOL and flags dangerous token-account states', async () => {
  const s = scenario();
  const ata = deriveAssociatedTokenAddress(s.wallet, s.jito.mint, TOKEN_PROGRAM_ID);
  s.chain.setAccount(ata, { lamports: 2_039_280n, owner: TOKEN_PROGRAM_ID, data: encodeTokenAccount({ mint: s.jito.mint, owner: s.wallet, amount: 800_000_000n }) });
  let { portfolio } = await load(s);
  const pos = portfolio.positions.find((p) => p.evaluation.config.symbol === 'JitoSOL')!;
  assert.equal(pos.exists, true);
  assert.equal(pos.tokens, 800_000_000n);
  assert.equal(pos.valueLamports, (800_000_000n * s.jito.totalLamports) / s.jito.poolTokenSupply);
  assert.equal(portfolio.totalValueLamports, 1_000_000_000n + pos.valueLamports + 2_039_280n);
  assert.deepEqual(pos.issues, []);

  s.chain.setAccount(ata, { lamports: 2_039_280n, owner: TOKEN_PROGRAM_ID, data: encodeTokenAccount({ mint: s.jito.mint, owner: s.wallet, amount: 1n, delegate: newAddress(), delegatedAmount: 1n }) });
  ({ portfolio } = await load(s));
  const p2 = portfolio.positions.find((p) => p.evaluation.config.symbol === 'JitoSOL')!;
  assert.equal(p2.issues[0]?.code, 'ata-delegate');
  assert.equal(p2.issues[0]?.blocksDeposit, true);
  assert.equal(p2.issues[0]?.blocksWithdraw, false, 'you must still be able to exit');
});

test('deposit plan for exactly 1 SOL keeps the reserve, pays rent and fee budget, and quotes exactly', async () => {
  const s = scenario();
  const { evaluations, portfolio, ctx } = await load(s);
  const chosen = selectDepositPool(evaluations, portfolio, s.policy);
  assert.ok(!('kind' in chosen));
  assert.equal(chosen.config.symbol, 'JitoSOL');
  const plan = planDeposit({ portfolio, evaluation: chosen, policy: s.policy, rentTokenAccount: ctx.rentTokenAccount });
  assert.equal(plan.kind, 'deposit');
  if (plan.kind !== 'deposit') return;
  // 1 SOL - 0.01 reserve - 0.00203928 rent - (5000 + 100000) max fee
  assert.equal(plan.lamports, 987_855_720n);
  assert.equal(plan.createAta, true);
  const q = quoteDepositSol(plan.verified.pool, plan.lamports);
  assert.deepEqual(plan.quote, q);
  assert.equal(plan.minPoolTokensOut, (q.userTokens * 9980n) / 10_000n);
  assert.ok(plan.entryCostBps < 0.01, 'zero-fee pool: only rounding');
  assert.equal(plan.solAfterLamports, s.policy.reserveLamports);
});

test('deposit planning refuses when there is nothing worth depositing or the request is too large', async () => {
  const small = scenario({ walletLamports: 40_000_000n });
  const a = await load(small);
  const pa = planDeposit({ portfolio: a.portfolio, evaluation: a.evaluations[0]!, policy: small.policy, rentTokenAccount: a.ctx.rentTokenAccount });
  assert.equal(pa.kind, 'noop');

  const s = scenario();
  const b = await load(s);
  const pb = planDeposit({ portfolio: b.portfolio, evaluation: b.evaluations[0]!, policy: s.policy, rentTokenAccount: b.ctx.rentTokenAccount, requestedLamports: 995_000_000n });
  assert.equal(pb.kind, 'noop');
  assert.match((pb as { reasons: string[] }).reasons[0]!, /keeping the reserve/);

  const blocked = scenario({ jito: { lastUpdateEpoch: 799n } });
  const c = await load(blocked);
  const pc = planDeposit({ portfolio: c.portfolio, evaluation: c.evaluations[0]!, policy: blocked.policy, rentTokenAccount: c.ctx.rentTokenAccount });
  assert.equal(pc.kind, 'noop');
  assert.match((pc as { reasons: string[] }).reasons.join(' '), /last updated/);
});

test('entry-cost cap rejects expensive deposits even when the fee cap would allow them', async () => {
  const s = scenario({ jito: { solDepositFee: { numerator: 2n, denominator: 1000n } }, policy: { maxSolDepositFeeBps: 50, maxDepositCostBps: 10 } });
  const { evaluations, portfolio, ctx } = await load(s);
  const plan = planDeposit({ portfolio, evaluation: evaluations[0]!, policy: s.policy, rentTokenAccount: ctx.rentTokenAccount });
  assert.equal(plan.kind, 'noop');
  assert.match((plan as { reasons: string[] }).reasons[0]!, /entry cost/);
});

test('referral share of the deposit fee is recaptured into our own account', async () => {
  const s = scenario({ jito: { solDepositFee: { numerator: 1n, denominator: 1000n }, solReferralFee: 50 } });
  const { evaluations, portfolio, ctx } = await load(s);
  const plan = planDeposit({ portfolio, evaluation: evaluations[0]!, policy: s.policy, rentTokenAccount: ctx.rentTokenAccount });
  assert.equal(plan.kind, 'deposit');
  if (plan.kind !== 'deposit') return;
  assert.ok(plan.quote.referralFeeTokens > 0n);
  assert.equal(plan.receivedTokens, plan.quote.userTokens + plan.quote.referralFeeTokens);
  assert.ok(plan.entryCostBps < 6 && plan.entryCostBps > 4, `half of a 10 bps fee comes back: ${plan.entryCostBps}`);
});

test('pool selection tops up an existing position unless another pool is clearly better', async () => {
  const s = scenario();
  const ata = deriveAssociatedTokenAddress(s.wallet, s.blaze.mint, TOKEN_PROGRAM_ID);
  s.chain.setAccount(ata, { lamports: 2_039_280n, owner: TOKEN_PROGRAM_ID, data: encodeTokenAccount({ mint: s.blaze.mint, owner: s.wallet, amount: 100_000_000n }) });
  const { evaluations, portfolio } = await load(s);
  const jitoScore = evaluations[0]!.metrics!.score!;
  const blazeScore = evaluations[1]!.metrics!.score!;
  const gainPp = (jitoScore - blazeScore) * 100;
  const keep = selectDepositPool(evaluations, portfolio, { ...s.policy, switchMinAprGainPct: gainPp + 0.1 });
  assert.equal((keep as { config: { symbol: string } }).config.symbol, 'bSOL');
  const move = selectDepositPool(evaluations, portfolio, { ...s.policy, switchMinAprGainPct: Math.max(0, gainPp - 0.1) });
  assert.equal((move as { config: { symbol: string } }).config.symbol, 'JitoSOL');
});

test('withdraw plans: full exit closes the account; reserve shortfall refuses', async () => {
  const s = scenario();
  const ata = deriveAssociatedTokenAddress(s.wallet, s.jito.mint, TOKEN_PROGRAM_ID);
  s.chain.setAccount(ata, { lamports: 2_039_280n, owner: TOKEN_PROGRAM_ID, data: encodeTokenAccount({ mint: s.jito.mint, owner: s.wallet, amount: 789_000_000n }) });
  const { portfolio } = await load(s);
  const pos = selectWithdrawPosition(portfolio);
  assert.ok(!('kind' in pos));
  const full = planWithdraw({ portfolio, position: pos, policy: s.policy });
  assert.equal(full.kind, 'withdraw');
  if (full.kind !== 'withdraw') return;
  assert.equal(full.closeAta, true);
  assert.equal(full.ataRentLamports, 2_039_280n);
  assert.equal(full.quote.feeTokens, 789_000n); // 0.1%
  assert.ok(Math.abs(full.exitCostBps - 10) < 0.1);

  const partial = planWithdraw({ portfolio, position: pos, policy: s.policy, requestedTokens: 1_000_000n });
  assert.equal(partial.kind === 'withdraw' && partial.closeAta, false);

  const dry = scenario({ walletLamports: 1_000_000_000n });
  dry.chain.setAccount(deriveAssociatedTokenAddress(dry.wallet, dry.jito.mint, TOKEN_PROGRAM_ID), {
    lamports: 2_039_280n,
    owner: TOKEN_PROGRAM_ID,
    data: encodeTokenAccount({ mint: dry.jito.mint, owner: dry.wallet, amount: 789_000_000n }),
  });
  dry.chain.accounts.get(dry.jito.reserveStake)!.lamports = 2_282_880n + 1_000n;
  const d = await load(dry);
  const pd = planWithdraw({ portfolio: d.portfolio, position: selectWithdrawPosition(d.portfolio) as never, policy: dry.policy });
  assert.equal(pd.kind, 'noop');
  assert.match((pd as { reasons: string[] }).reasons[0]!, /reserve can pay out/);
});
