# Strategy decision record

**Goal:** grow a balance of **1 SOL**, measured **in SOL**, **safely**.
**Decision:** liquid-stake it via a **direct deposit into a verified, allowlisted SPL stake pool**
(default candidates: JitoSOL, bSOL). Keep a small liquid fee reserve. Change nothing unless monitoring shows a reason.

## 1. What "safely" has to mean here

"Safe" rules out any strategy whose plausible bad case is losing principal. So it rules out leverage,
price speculation, and anything that depends on out-trading professionals. What's left is protocol-level yield.
Solana pays that to stakers in SOL from two sources:

* **Inflation rewards.** New SOL is issued every epoch to staked accounts. Unstaked SOL is diluted by it.
  This is the only source of SOL-denominated yield that doesn't depend on someone else losing a trade.
* **MEV tips.** Searchers pay these to block producers, and many validators share them with stakers.

Historically, liquid staking on Solana has returned roughly **6–8% APY in SOL terms**, net of fees.
The figure trends down over time because the inflation schedule decays about 15% per year. The tool never
assumes a number: `solprofits pools` computes each pool's yield from on-chain data, and `status` builds
a multi-epoch trailing yield from its own ledger.

> Growth is measured in SOL. Staking does nothing to protect the **dollar value** of the position.
> SOL's price can halve while your SOL count grows. That trade-off is inherent to the stated goal.

## 2. Options considered

| Option | Expected SOL return | What can go wrong | Verdict |
|---|---|---|---|
| Hold idle SOL | 0%, and your share of supply is diluted by inflation | nothing (except dilution) | Baseline only |
| **Liquid staking, direct SPL stake-pool deposit** | staking + MEV, net of the pool's reward fee | stake-pool program/manager risk, exit liquidity | **Chosen** |
| Native staking to one validator | staking (+ MEV if shared), minus commission | single-validator downtime or commission hikes; warm-up/cool-down epochs; minimum-delegation rules; needs active re-delegation | Good alternative; more upkeep, no diversification at 1 SOL |
| LST deposited in a lending market | +~0–0.5% on top | a second protocol (bad debt, oracle failures) for a tiny gain | Not worth the added risk |
| Leveraged "staking loops" | amplifies (staking − borrow rate) | goes negative when SOL borrow rates spike; liquidation on depeg | Rejected: principal at risk |
| LST/SOL liquidity provision | small fee income | AMM contract risk, small impermanent loss, operational overhead | Rejected at this size |
| Active trading, memecoins, sniping | negative expected value for retail after fees and slippage | total loss | Rejected |
| Arbitrage / MEV bot | negative for a 1 SOL bot against co-located professional searchers | fees on failed attempts, infrastructure cost | Rejected |
| "High-yield" vaults, airdrop farming, unknown protocols | n/a | rug pulls, drainers, unaudited code | Rejected |

## 3. Why liquid staking via a direct pool deposit

1. **Same yield source as native staking.** It also diversifies across the pool's whole validator set.
   With 1 SOL you can't spread native stake across validators.
2. **No active management.** The pool's staker/steward handles validator selection and rebalancing.
   Rewards compound into the token's exchange rate automatically. A safe strategy shouldn't need a hot key
   online: after the first deposit, everything is read-only monitoring.
3. **Instant, cheap exit.** `WithdrawSol` redeems from the pool reserve at the pool's own rate, so DEX liquidity
   and market depegs don't matter. Its fee is read on-chain and capped by policy (default ≤ 0.5%).
4. **Small surface area.** A direct deposit calls exactly one program: the canonical SPL stake pool program,
   which is widely used and has been audited several times. The tool skips aggregators and routers, so
   "best route" logic can't send funds anywhere unexpected.
5. **Program-enforced minimum output.** `DepositSolWithSlippage` / `WithdrawSolWithSlippage` make the program
   itself revert if it would mint or pay less than the quote minus 0.2%. That defeats a pool manager who
   front-runs your deposit with an instant deposit-fee hike, which is a real attack surface in SPL stake pools.

## 4. Pool selection

Each allowlisted pool is first **verified on-chain**:

* owner program
* mint
* mint authority equals the derived withdraw-authority address
* bump seed
* no freeze authority
* supply consistency
* reserve
* fee account

Only then is it **scored**:

```
score = min(APY_last_epoch, 15%)  −  SOL deposit fee  −  SOL instant-withdrawal fee
```

The APY comes from the pool's own `last_epoch_total_lamports` / `last_epoch_pool_token_supply` fields, which the
program keeps "for APR estimation". It is net of the pool's reward fee and compounded over the measured number of
epochs per year. A pool is **excluded** from deposits if any of these hold:

* its reward fee is above 10%
* its deposit fee is above 0.3% or its instant-exit fee is above 0.5%
* a fee increase above the caps is pending
* TVL is below 100k SOL
* it isn't updated for the current epoch
* deposits or withdrawals are gated by an authority
* its token value fell over the last epoch

New SOL tops up the existing position. A switch is only *suggested*, never automatic, when another pool scores
at least 0.5 percentage points per year better. Single-epoch figures are noisy, so confirm a gap over several
epochs (the `status` trailing APY) before acting on it.

## 5. What to expect (illustrative, not a promise)

With 1 SOL: 0.98786 SOL is staked, 0.01 SOL stays liquid for fees, and 0.00204 SOL is refundable token-account
rent. Total SOL value under a constant APY:

| APY | after 1 year | after 3 years | after 5 years |
|---|---|---|---|
| 5% | 1.0493 SOL | 1.1556 SOL | 1.2728 SOL |
| 6% | 1.0592 SOL | 1.1886 SOL | 1.3340 SOL |
| 7% | 1.0690 SOL | 1.2222 SOL | 1.3976 SOL |
| 8% | 1.0789 SOL | 1.2565 SOL | 1.4635 SOL |

Exiting through the instant `WithdrawSol` path costs the pool's withdrawal fee once, e.g. 0.1% ≈ 0.001 SOL.
Anything that promises materially more than this in SOL terms is taking risk with your principal.

## 6. Risk register

| Risk | Mitigation in this design |
|---|---|
| Key theft | Use a dedicated wallet holding only this SOL. Read-only commands need just the public address. The key is loaded only for `--execute`, the raw-key env var is scrubbed after reading, key files are permission-checked, and key material is never logged. The tool has only two runtime dependencies (audited @noble crypto), with exact pins, a lockfile and `ignore-scripts`. |
| Buggy or malicious transaction | A firewall decodes the exact bytes to be signed. It allows only 4 programs, a single signer, and the wallet's own token account as the destination (re-derived), with fee caps. The final bytes are simulated and must reproduce the exact quote within 1 bps. Encoders are byte-checked against the official libraries in tests. |
| The tool being misused (e.g. an agent tricked by injected text) | No code path can send SOL or tokens to any address other than allowlisted pools and back to the same wallet. The firewall rejects everything else, including plain SOL transfers. |
| Wrong network or lying RPC | The genesis hash must match mainnet before signing. Destination accounts are derived locally. The program enforces every account relationship and the minimum output. |
| Pool manager abuse | The on-chain minimum output defeats instant deposit-fee hikes. Reward- and withdrawal-fee increases take 1–2 epochs to apply by protocol design, and the monitor pages on any pending increase. Pools with gated SOL withdrawals are excluded. |
| Stake pool program bug or upgrade | Only the canonical program is allowlisted. The monitor flags any upgrade within about 2 epochs. Two pools share one program, so splitting across them diversifies manager/validator risk, not program risk. |
| Validator downtime or slashing | The pool's stake is diversified. The monitor raises a critical alert if pool value per token ever decreases. |
| Exit liquidity | The monitor warns when the reserve can't cover an instant exit. Fallbacks: wait (reserves refill), exit partially, or use the pool's stake withdrawal (RUNBOOK). |
| Fee drain | Priority fees are capped at 0.0001 SOL per transaction and enforced by the firewall. A 0.01 SOL reserve pays for about 95 worst-case transactions. |
| Operator error | Dry-run is the default. Signing needs `--execute` plus confirmation. There's a kill switch, a per-transaction cap, and the policy file rejects unknown or unsafe values. |
| SOL/USD price | Not mitigated: the goal is denominated in SOL. |

## 7. What would change this decision

* **Native staking.** Switch if a well-run validator's net yield (low commission, MEV sharing) clearly beats the
  pools after fees, and you'd rather avoid the stake-pool program layer and accept re-delegation upkeep.
* **A pool turning hostile.** Switch on fee hikes, gating, value drops or stalled updates. The monitor detects
  these, and you withdraw and redeposit elsewhere.
* **A larger balance.** Split across two or more pools run by different managers, or mix with native stake
  across several validators.

*Not financial or tax advice. In many jurisdictions, staking rewards or LST conversions can be taxable events.*
