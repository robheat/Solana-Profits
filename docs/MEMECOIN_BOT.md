# Memecoin momentum bot (high risk)

> **Expect to lose money.** This bot exists because you asked for a strategy that targets 100% growth per month
> and chose to put the whole balance at risk. No strategy delivers that reliably. Without a real edge over the
> other side of your trades, the chance of *ever* multiplying your money by N is at most 1 in N (Ville's inequality).
> That puts doubling once at no better than 50%, and a year of monthly doubling at no better than 1 in 4,096.
> Fees, slippage and faster bots make the real odds worse. The parameters below are untuned starting points
> with no proven edge.

The safe alternative, liquid staking at about 6% a year, is the rest of this repository and is unaffected by the bot.

## What it does

Every 30 seconds it values each open position with a live sell quote and applies the exit rules. Every 2 minutes,
if there's room, it looks for **one** new entry.

**Entry:**

1. **Discovery.** It reads the trending tokens of the last hour from the Jupiter Tokens API.
2. **Screening.** A token must pass every filter in `config/bot-policy.json`:
   * liquidity ≥ $100k and market cap between $1M and $250M
   * ≥ 1,000 holders, top holders ≤ 30%, developer ≤ 5%
   * organic score ≥ 40 (filters bot and wash volume)
   * at least 6 hours old (fresh launches rug most often)
   * up 10–150% over the last hour (rising, but not a blow-off), still rising over the last 5 minutes
   * more buy volume than sell volume
3. **Ranking.** Survivors are ranked by momentum × organic score × buy pressure.
4. **On-chain checks** (the feed's claims aren't trusted). The mint must have:
   * no mint authority (no infinite printing)
   * no freeze authority (your balance can't be frozen)
   * no dangerous Token-2022 extensions: transfer fee, transfer hook, permanent delegate, default-frozen accounts,
     non-transferable, pausable, scaled balances
   * decimals that match the feed
5. **Quote checks.** Price impact ≤ 2%. A buy-then-sell round trip must lose ≤ 6%; this catches taxed or
   illiquid tokens.
6. **Sizing.** 30% of equity per position, at most 3 open positions. 0.02 SOL always stays in reserve for exits,
   and nothing new is bought once equity falls below 0.2 SOL.

**Exits:**

| Rule | Trigger | Action |
|---|---|---|
| Take profit (the "100%" target) | position value ≥ 2× its cost | sell half: you have your stake back, the rest rides for free |
| Trailing stop | after the take-profit, value 30% below its peak | sell the rest |
| Stop loss | before the take-profit, value 30% below cost | sell everything, with up to 10% slippage allowed so the exit happens |
| Time stop | held 48 hours | sell everything |

A token isn't bought again for 24 hours after exiting it.

## What protects the funds from everything except the market

* **Swap firewall.** It runs over the fully resolved v0 transaction, lookup tables included, before signing:
  * the wallet is the only signer
  * only compute-budget, system, associated-token, token and the Jupiter v6 programs are allowed
  * SOL may only be wrapped into the wallet's own wrapped-SOL account
  * exactly one Jupiter route, spending exactly the quoted amount at the quoted minimum output, with no platform fee
  * the route's source and destination are the wallet's own token accounts
  * the priority fee is capped
* **Simulation of the exact bytes.** SOL spent and tokens received have to match the quote before signing.
* **Program-enforced minimum output.** If the price moves past the slippage tolerance between the quote and
  execution, Jupiter's program reverts the swap; only the network fee is lost. Tested.
* **Write-ahead buy marker plus chain reconciliation.** A crash or an unconfirmed transaction can't cause a
  duplicate buy or a forgotten position. A buy that landed late is adopted on the next tick.
* **No interaction with unknown tokens.** Airdropped tokens in the wallet are reported and never touched,
  because many are phishing bait.
* **Live trading starts only after a gate.** It needs `--execute`, a typed confirmation (or `--yes`), a mainnet
  genesis-hash check and a pre-flight swap simulation through the firewall. `touch HALT` stops all signing.

## What it can NOT protect you from

* **Crashes faster than the tick.** A token can fall 80% in seconds. The −30% stop then fills far below −30%,
  or not at all if liquidity is gone.
* **Liquidity pulls and insider dumps** by the people behind a token. None of the checks can detect intent.
* **MEV sandwiching** within your slippage tolerance (2% on buys, 3% on sells, up to 10% on stop-loss exits).
* **Gamed signals.** Holder counts, organic scores and trending lists can be manipulated.
* **Downtime** of your machine, the RPC or Jupiter. Positions aren't managed while the bot is down.
* **Paper results are optimistic.** Paper fills happen at the quoted price, with no MEV, failed transactions or latency.

## How to run it

The bot has to run continuously on your own computer or a server; a cloud chat session can't host it. It needs
network access to a Solana RPC and to Jupiter (`lite-api.jup.ag`, or `api.jup.ag` with `JUPITER_API_KEY`).

1. **Separate wallet.** Use a dedicated wallet for the bot: it holds a hot key for as long as it runs. The bot
   trades only the wallet's liquid SOL. If that SOL is staked through the staking tool, withdraw it first
   (`solprofits withdraw --execute`).
2. **Look:** `node src/cli.ts bot scan` shows today's candidates and why the others were rejected.
3. **Verify:** `node src/cli.ts bot selfcheck --address <WALLET>` must end with **All checks passed**. It confirms
   the Jupiter API formats and runs a real Jupiter swap transaction through the firewall and a simulation,
   without signing.
4. **Paper-trade for at least a week:** `node src/cli.ts bot paper --start-sol 1`. Check results with
   `node src/cli.ts bot status --paper`. If it can't make money on paper, it won't with real money.
5. **Live:** `SOLANA_KEYPAIR_PATH=… node src/cli.ts bot run --execute`. To keep it running, use the hardened
   systemd unit in [deploy/solprofits-bot.service](../deploy/solprofits-bot.service), or `tmux`.
6. **Stop:**
   * Ctrl-C finishes the current step and stops.
   * `touch HALT` blocks all signing.
   * `node src/cli.ts bot liquidate --execute` sells everything back to SOL.

## Verification status

* **Tested against mocks only.** The tests cover parsing, on-chain checks (Token-2022 extensions cross-checked
  with `@solana/spl-token`), every strategy rule, ten firewall tampering cases, slippage reverts, the
  paper and live engines, crash reconciliation, and the full CLI in child processes. The mock chain and mock
  Jupiter build and decode real v0 transactions with the official libraries.
* **Not yet confirmed against the real Jupiter API.** The build environment had no network access, so these
  assumptions are untested:
  * API paths: `/swap/v1/quote`, `/swap/v1/swap`, `/tokens/v2/toptrending/1h`
  * response field names
  * `priceImpactPct` is a fraction (0.01 = 1%)
  * the account order of Jupiter v6 `route` / `shared_accounts_route`, and the 19-byte data tail
    (in amount, quoted out, slippage, platform fee)

  `bot selfcheck` checks all of these against live data, and `bot run` refuses to start if its pre-flight
  fails. If Jupiter's format differs, the firewall fails closed: the bot rejects the trade.

## Parameters (`config/bot-policy.json`)

Every value can be changed; unknown keys are rejected.

| Key | Default | Meaning |
|---|---|---|
| `feeReserveSol` | 0.02 | never invested; pays for exits (min 0.01) |
| `maxOpenPositions` / `positionFraction` | 3 / 0.3 | concurrency and per-position size (share of equity) |
| `minPositionSol` | 0.05 | smaller entries are skipped |
| `takeProfitPct` / `takeProfitSellFraction` | 100 / 0.5 | sell half at +100% |
| `trailingStopPct` | 30 | after the take-profit |
| `stopLossPct` | 30 | before the take-profit |
| `maxHoldHours` | 48 | time stop |
| `equityFloorSol` | 0.2 | no new buys below this equity |
| `cooldownHours` | 24 | no re-entry into a token you just exited |
| `buySlippageBps` / `sellSlippageBps` / `emergencySlippageBps` | 200 / 300 / 1000 | program-enforced price tolerance |
| `maxPriceImpactPct` / `maxRoundTripLossPct` | 2 / 6 | entry liquidity checks |
| `maxPriorityFeeSol` | 0.0005 | per-transaction cap (max 0.005) |
| `scanIntervalSeconds` / `tickIntervalSeconds` | 120 / 30 | loop timing |
| `filters.*` | see file | screening thresholds |
