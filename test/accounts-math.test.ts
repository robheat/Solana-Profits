// Account decoders vs the official layouts, and the stake pool math vs program semantics.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeMint, decodeProgramData, decodeStakePool, decodeTokenAccount, decodeUpgradeableProgram } from '../src/solana/accounts.ts';
import {
  annualize,
  applyFee,
  calcLamportsWithdrawAmount,
  calcPoolTokensForDeposit,
  CalculationError,
  lastEpochReturn,
  poolTokensToLamports,
  quoteDepositSol,
  quoteWithdrawSol,
} from '../src/core/math.ts';
import { addressToBytes } from '../src/crypto/keys.ts';
import { concatBytes, u32le, u64le } from '../src/util/bytes.ts';
import { encodeMint, encodeStakePool, encodeTokenAccount, makePoolFixture, newAddress } from './fixtures.ts';

test('StakePool decoder matches the official layout with every optional field set', () => {
  const f = makePoolFixture({
    nextEpochFee: { numerator: 5n, denominator: 100n },
    nextSolWithdrawalFee: { numerator: 3n, denominator: 1000n },
    nextStakeWithdrawalFee: { numerator: 2n, denominator: 1000n },
    solDepositAuthority: newAddress(),
    solWithdrawAuthority: newAddress(),
    preferredDeposit: newAddress(),
    preferredWithdraw: newAddress(),
    solReferralFee: 50,
    stakeReferralFee: 25,
    solDepositFee: { numerator: 1n, denominator: 1000n },
  });
  const p = decodeStakePool(encodeStakePool(f));
  assert.equal(p.accountType, 1);
  assert.equal(p.manager, f.manager);
  assert.equal(p.staker, f.staker);
  assert.equal(p.stakeWithdrawBumpSeed, f.bump);
  assert.equal(p.validatorList, f.validatorList);
  assert.equal(p.reserveStake, f.reserveStake);
  assert.equal(p.poolMint, f.mint);
  assert.equal(p.managerFeeAccount, f.managerFeeAccount);
  assert.equal(p.tokenProgramId, f.tokenProgramId);
  assert.equal(p.totalLamports, f.totalLamports);
  assert.equal(p.poolTokenSupply, f.poolTokenSupply);
  assert.equal(p.lastUpdateEpoch, f.lastUpdateEpoch);
  assert.deepEqual(p.epochFee, f.epochFee);
  assert.deepEqual(p.nextEpochFee?.fee, f.nextEpochFee);
  assert.equal(p.preferredDepositValidatorVoteAddress, f.preferredDeposit);
  assert.equal(p.preferredWithdrawValidatorVoteAddress, f.preferredWithdraw);
  assert.deepEqual(p.stakeWithdrawalFee, f.stakeWithdrawalFee);
  assert.deepEqual(p.nextStakeWithdrawalFee?.fee, f.nextStakeWithdrawalFee);
  assert.equal(p.stakeReferralFee, 25);
  assert.equal(p.solDepositAuthority, f.solDepositAuthority);
  assert.deepEqual(p.solDepositFee, f.solDepositFee);
  assert.equal(p.solReferralFee, 50);
  assert.equal(p.solWithdrawAuthority, f.solWithdrawAuthority);
  assert.deepEqual(p.solWithdrawalFee, f.solWithdrawalFee);
  assert.deepEqual(p.nextSolWithdrawalFee?.fee, f.nextSolWithdrawalFee);
  assert.equal(p.lastEpochPoolTokenSupply, f.lastEpochPoolTokenSupply);
  assert.equal(p.lastEpochTotalLamports, f.lastEpochTotalLamports);
});

test('StakePool decoder matches the official layout with every optional field empty', () => {
  const f = makePoolFixture();
  const p = decodeStakePool(encodeStakePool(f));
  assert.equal(p.nextEpochFee, null);
  assert.equal(p.solDepositAuthority, null);
  assert.equal(p.solWithdrawAuthority, null);
  assert.equal(p.nextSolWithdrawalFee, null);
  assert.equal(p.preferredDepositValidatorVoteAddress, null);
  assert.equal(p.lastEpochTotalLamports, f.lastEpochTotalLamports);
  assert.equal(p.lastEpochPoolTokenSupply, f.lastEpochPoolTokenSupply);
});

test('FutureEpoch tag 1 (one epoch remaining) decodes; bad tags and non-pool accounts are rejected', () => {
  const data = encodeStakePool(makePoolFixture({ nextEpochFee: { numerator: 7n, denominator: 100n } }));
  // next_epoch_fee tag sits right after epoch_fee: 1+32*3+1+32*5+8*3+48+16 = 346
  assert.equal(data[346], 2, 'official encoder writes tag 2');
  const one = Uint8Array.from(data);
  one[346] = 1;
  assert.equal(decodeStakePool(one).nextEpochFee?.epochsUntilActive, 1);
  const bad = Uint8Array.from(data);
  bad[346] = 3;
  assert.throws(() => decodeStakePool(bad), /FutureEpoch/);
  const notPool = Uint8Array.from(data);
  notPool[0] = 2; // ValidatorList
  assert.throws(() => decodeStakePool(notPool), /not a stake pool/);
  assert.throws(() => decodeStakePool(data.slice(0, 300)));
});

test('Mint and token account decoders match @solana/spl-token layouts', () => {
  const auth = newAddress();
  const freeze = newAddress();
  const m = decodeMint(encodeMint({ mintAuthority: auth, supply: 123_456_789_012_345_678n, decimals: 9, freezeAuthority: freeze }));
  assert.deepEqual(m, { mintAuthority: auth, supply: 123_456_789_012_345_678n, decimals: 9, isInitialized: true, freezeAuthority: freeze });
  const m2 = decodeMint(encodeMint({ mintAuthority: null, supply: 1n }));
  assert.equal(m2.mintAuthority, null);
  assert.equal(m2.freezeAuthority, null);

  const mint = newAddress();
  const owner = newAddress();
  const delegate = newAddress();
  const t = decodeTokenAccount(encodeTokenAccount({ mint, owner, amount: 42n, delegate, delegatedAmount: 7n, closeAuthority: owner }));
  assert.equal(t.mint, mint);
  assert.equal(t.owner, owner);
  assert.equal(t.amount, 42n);
  assert.equal(t.delegate, delegate);
  assert.equal(t.delegatedAmount, 7n);
  assert.equal(t.state, 1);
  assert.equal(t.isNative, null);
  assert.equal(t.closeAuthority, owner);
  assert.throws(() => decodeTokenAccount(new Uint8Array(100)));
});

test('upgradeable loader program / programdata decoding', () => {
  const pd = newAddress();
  assert.equal(decodeUpgradeableProgram(concatBytes(u32le(2), addressToBytes(pd))), pd);
  const auth = newAddress();
  const withAuth = decodeProgramData(concatBytes(u32le(3), u64le(123_456n), Uint8Array.of(1), addressToBytes(auth)));
  assert.deepEqual(withAuth, { slot: 123_456n, upgradeAuthority: auth });
  assert.deepEqual(decodeProgramData(concatBytes(u32le(3), u64le(9n), Uint8Array.of(0))), { slot: 9n, upgradeAuthority: null });
  assert.throws(() => decodeUpgradeableProgram(concatBytes(u32le(3), addressToBytes(pd))));
});

// ------------------------------------------------------------------ math

test('Fee::apply rounds UP and treats a zero denominator as no fee', () => {
  assert.equal(applyFee({ numerator: 1n, denominator: 1000n }, 1n), 1n); // ceil(0.001)
  assert.equal(applyFee({ numerator: 1n, denominator: 1000n }, 1000n), 1n);
  assert.equal(applyFee({ numerator: 1n, denominator: 1000n }, 1001n), 2n);
  assert.equal(applyFee({ numerator: 0n, denominator: 1000n }, 5000n), 0n);
  assert.equal(applyFee({ numerator: 5n, denominator: 0n }, 5000n), 0n);
});

test('deposit quote mirrors process_deposit_sol, including referral split and rounding down', () => {
  const pool = decodeStakePool(
    encodeStakePool(
      makePoolFixture({
        totalLamports: 1_250n * 10n ** 12n,
        poolTokenSupply: 1_000n * 10n ** 12n,
        solDepositFee: { numerator: 2n, denominator: 1000n }, // 0.2%
        solReferralFee: 50,
      }),
    ),
  );
  const q = quoteDepositSol(pool, 1_000_000_001n);
  // new tokens = floor(1_000_000_001 * 1000 / 1250) = 800_000_000
  assert.equal(q.newPoolTokens, 800_000_000n);
  // fee = ceil(800_000_000 * 2 / 1000) = 1_600_000; referral = floor(1_600_000 * 50 / 100)
  assert.equal(q.depositFeeTokens, 1_600_000n);
  assert.equal(q.referralFeeTokens, 800_000n);
  assert.equal(q.managerFeeTokens, 800_000n);
  assert.equal(q.userTokens, 798_400_000n);
  assert.equal(q.userTokens + q.managerFeeTokens + q.referralFeeTokens, q.newPoolTokens);
});

test('fee-free pool: deposit then immediate redemption never returns MORE than deposited', () => {
  const pool = decodeStakePool(encodeStakePool(makePoolFixture({ solWithdrawalFee: { numerator: 0n, denominator: 0n } })));
  for (const lamports of [1n, 999n, 123_456_789n, 985_000_000n, 1_000_000_000n]) {
    let q;
    try {
      q = quoteDepositSol(pool, lamports);
    } catch (e) {
      assert.ok(e instanceof CalculationError && lamports === 1n, 'only a 1-lamport deposit may round to zero tokens');
      continue;
    }
    const back = poolTokensToLamports(pool, q.userTokens);
    assert.ok(back <= lamports, 'rounding must favour the pool, never the depositor');
    assert.ok(lamports - back <= 2n, `rounding loss should be a couple of lamports, got ${lamports - back}`);
  }
});

test('withdraw quote mirrors process_withdraw_sol (fee taken in pool tokens first)', () => {
  const pool = decodeStakePool(
    encodeStakePool(
      makePoolFixture({ totalLamports: 1_250n * 10n ** 12n, poolTokenSupply: 1_000n * 10n ** 12n, solWithdrawalFee: { numerator: 1n, denominator: 1000n } }),
    ),
  );
  const q = quoteWithdrawSol(pool, 800_000_000n);
  assert.equal(q.feeTokens, 800_000n);
  assert.equal(q.burnedTokens, 799_200_000n);
  assert.equal(q.lamportsOut, calcLamportsWithdrawAmount(pool, 799_200_000n));
  assert.equal(q.lamportsOut, 999_000_000n);
  assert.throws(() => quoteWithdrawSol(pool, 0n), /WithdrawalTooSmall/);
});

test('empty pools convert 1:1 like the program', () => {
  const pool = decodeStakePool(encodeStakePool(makePoolFixture({ totalLamports: 0n, poolTokenSupply: 0n })));
  assert.equal(calcPoolTokensForDeposit(pool, 12345n), 12345n);
  assert.equal(calcLamportsWithdrawAmount(pool, 12345n), 0n);
});

test('last-epoch return and annualization', () => {
  const pool = decodeStakePool(
    encodeStakePool(
      makePoolFixture({
        totalLamports: 1_000_370_000n,
        poolTokenSupply: 1_000_000_000n,
        lastEpochTotalLamports: 1_000_000_000n,
        lastEpochPoolTokenSupply: 1_000_000_000n,
      }),
    ),
  );
  const r = lastEpochReturn(pool)!;
  assert.ok(Math.abs(r - 0.00037) < 1e-12);
  const apy = annualize(r, 182.5);
  assert.ok(apy > 0.069 && apy < 0.0699, `apy ${apy}`);
  const none = decodeStakePool(encodeStakePool(makePoolFixture({ lastEpochTotalLamports: 0n, lastEpochPoolTokenSupply: 0n })));
  assert.equal(lastEpochReturn(none), null);
  // Rate unaffected by deposits that scale lamports and supply together.
  const scaled = decodeStakePool(
    encodeStakePool(
      makePoolFixture({
        totalLamports: 2_000_740_000n,
        poolTokenSupply: 2_000_000_000n,
        lastEpochTotalLamports: 1_000_000_000n,
        lastEpochPoolTokenSupply: 1_000_000_000n,
      }),
    ),
  );
  assert.ok(Math.abs(lastEpochReturn(scaled)! - 0.00037) < 1e-12);
});
