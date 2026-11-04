# Switching strategies with market conditions

`solprofits auto` reads market conditions every hour and splits the wallet between three strategies,
using the guarded executors already in this repo:

| Strategy | What it does | Earns (in SOL) | Shines when | Main risk |
|---|---|---|---|---|
| **Stake** | liquid-stakes SOL in a verified pool (JitoSOL / bSOL) | ~5–7%/yr, compounding | always; it's the default | stake-pool program/manager risk |
| **USDC hedge** | swaps SOL into USDC, buys SOL back later | more SOL if SOL falls while hedged; less if it rises | sustained SOL downtrends | whipsaws; no staking yield while hedged; USDC issuer risk |
| **Memecoin momentum** | the high-risk bot ([MEMECOIN_BOT.md](MEMECOIN_BOT.md)), capped by a budget | lottery-like, negative on average | hot memecoin markets in a SOL uptrend | losing the budget |

Measured in SOL, the hedge is the only strategy that can *add* SOL when the price falls. You sell SOL high and
buy more back lower. It loses SOL when a "downtrend" turns out to be noise and you buy back higher.

## Reading the market

* **Trend.** SOL's 1-day average is compared with its 7-day average, both exponential moving averages of hourly
  closes. 3% or more above, with the price over the 7-day average, is **up**. 3% or more below, with the price
  under it, is **down**. Anything else is **range**. Once a trend is established it holds until the gap shrinks
  below 1%. Without this exit threshold, a trend hovering near the line flips back and forth, and every flip
  costs fees.
* **Memecoin heat.** Of the top 50 trending tokens, the market is **hot** when at least 60% are rising and at
  least 2 pass the bot's own entry filters.
* **Volatility.** Above 120% a year (annualized), the memecoin share is halved.
* **Data quality.** History comes from the Pyth oracle's public benchmarks API. Its latest close must be under
  3 hours old and within 3% of an executable Jupiter quote. Otherwise the cycle makes **no decision and no
  trades**.

## Regimes and the default ("balanced") allocation

| Regime | When | Stake | USDC hedge | Memecoins |
|---|---|---|---|---|
| `risk-on` | SOL up and memecoins hot | 80% | 0% | 20% |
| `uptrend` | SOL up | 100% | 0% | 0% |
| `range` | no clear trend | 100% | 0% | 0% |
| `downtrend` | SOL down | 30% | 70% | 0% |
| `unknown` | start-up, under 14 days of history | 100% | 0% | 0% |

There are also `conservative` and `aggressive` profiles:

* **conservative**: never trades memecoins; hedges 40% in a downtrend.
* **aggressive**:
  * `risk-on`: 60% memecoins
  * `uptrend`: 20% memecoins
  * `range`: 10% memecoins
  * `downtrend`: 100% hedged

Select one with `"profile"` in [config/router-policy.json](../config/router-policy.json) or `--profile`. A hot
memecoin market never overrides a SOL downtrend.

## Switching discipline

* **Confirmation.** A new regime must be observed 3 hourly checks in a row.
* **De-risk fast, re-risk slowly.** Moving to a *safer* regime happens as soon as it's confirmed. Moving to a
  *riskier* one also waits until the current regime is at least 24 hours old.
* **Bands.** A strategy is only traded when it's more than 10% of equity off target, and never below 0.02 SOL.
* **Order.** Moves free liquidity first (sell USDC, unstake), then fund (buy USDC, stake). They run one at a
  time, re-reading the wallet between moves.
* **Reserve.** 0.03 SOL always stays liquid, and SOL earmarked for the memecoin budget is never staked or swapped.
* **Memecoins switched off.** When a regime turns them off, no new positions open. Existing ones finish on their
  own exit rules (≤ 48h), or are sold at once with `"momentumExitOnDisable": true`.
* **One trading loop.** `auto run` and `bot run` share a lock, so they can never trade the wallet at the same time.

## What switching costs, and what to expect

Each switch pays the staking pool's instant-exit fee (~0.1%), swap fees and slippage (SOL↔USDC is deep: about
0.05–0.1%), and network fees. Bigger than any fee is the **whipsaw cost**: a false downtrend signal sells SOL and
buys it back higher.

The behavior on synthetic markets, as a sanity check (*not evidence*: real markets aren't synthetic):

* **A steady 50% crash.** Switching ended with far more SOL than staking, and about half the USD drawdown.
* **A steady rally.** It roughly matched staking.
* **Sideways chop.** It lost a few percent to false signals.

The hysteresis that prevents churn in real trends makes false signals last longer: that's the trade-off.

Run the backtest on real history before trusting any of this.

```bash
node src/cli.ts auto backtest --days 365
```

```bash
node src/cli.ts auto backtest --csv sol-usd-hourly.csv --profile aggressive
```

The memecoin strategy can't be backtested: there's no historical memecoin data. Its share is treated as staked
in backtests, so paper-trade it with `bot paper`.

## How to run it

1. **Look:** `node src/cli.ts auto regime --address <WALLET>` shows the market reading and the allocation it
   implies. It also confirms the Pyth feed and the Jupiter cross-check work from your machine.
2. **Dry run:** `node src/cli.ts auto plan --address <WALLET>` shows the exact moves for your wallet now, and
   simulates the first one. Nothing is signed and the regime tracker doesn't advance.
3. **Live:** `SOLANA_KEYPAIR_PATH=… node src/cli.ts auto run --execute`. The startup gate is the same as the
   bot's: a mainnet check, a pre-flight swap simulation and a typed confirmation. To keep it running, use the
   systemd unit in `deploy/` with `ExecStart=… auto run --execute --yes`.
4. **Inspect:** `node src/cli.ts auto status` shows the active regime, any pending switch, the switch history
   and the memecoin budget.
5. **Stop:** Ctrl-C stops the loop. `touch HALT` blocks all signing.

The live loop needs network access to a Solana RPC, Jupiter (`lite-api.jup.ag`) and `benchmarks.pyth.network`.
Like the bot, it has to run on your own computer or a server.

## Limits

* **No regime model predicts the market.** These rules react to trends that already exist, and pay for it in
  choppy markets. The thresholds are untuned starting points.
* **USDC isn't risk-free.** Circle can freeze USDC token accounts (the USDC mint has a freeze authority), and
  stablecoins can depeg. The hedge accepts both risks for its share of the wallet.
* **No staking yield while hedged.** The hedged share earns nothing.
* **Verification.** Tested with unit tests, synthetic backtests, and end-to-end runs on the mock chain: real
  stake-pool deposits and withdrawals and firewall-checked USDC swaps there, plus refusals on stale or
  disagreeing data. Not yet run against the live Pyth, Jupiter or mainnet services: the build environment
  blocked them.

## Parameters (`config/router-policy.json`)

| Key | Default | Meaning |
|---|---|---|
| `profile` | balanced | which weight table to use |
| `trend.fastHours` / `slowHours` | 24 / 168 | moving-average lengths (hours) |
| `trend.bullThresholdPct` / `bearThresholdPct` / `exitThresholdPct` | 3 / 3 / 1 | enter a trend at ±3%, leave it below ±1% |
| `volatility.highAnnualPct` / `momentumScaleWhenHigh` | 120 / 0.5 | cut the memecoin share in wild markets |
| `memeHeat.topN` / `minBreadth` / `minPassing` | 50 / 0.6 / 2 | when memecoins count as hot |
| `switching.confirmations` / `minDwellHours` / `evaluateMinutes` | 3 / 24 / 60 | switching discipline |
| `rebalance.bandPct` / `minTradeSol` | 10 / 0.02 | when a strategy is far enough off target to trade |
| `feeReserveSol` | 0.03 | never allocated |
| `hedge.*` | USDC, 0.5% slippage, 0.5% impact | the hedge asset and its trading limits |
| `dataCheck.maxPriceDisagreementPct` / `maxStalenessMinutes` | 3 / 180 | when the data is not trusted |
| `momentumExitOnDisable` | false | sell memecoins immediately when switched off |
| `backtest.*` | 6% APY, 10 bps swaps, 10 bps unstake, 0.00002 SOL per tx | backtest assumptions |
