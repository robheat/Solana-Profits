# Solana-Profits

A small, auditable tool with one job: **grow a 1 SOL balance safely, in SOL terms.**

It does that the only way that holds up under scrutiny: **liquid staking** through a direct deposit into a
verified, allowlisted SPL stake pool (JitoSOL / bSOL by default). It wraps every step in guardrails, so a bug,
a lying RPC, a hostile pool manager or a misdirected agent can't lose the funds.

## Realistic expectations

* Staking on Solana has historically returned **≈ 6–8% APY in SOL**, from inflation rewards plus MEV tips,
  net of pool fees. The rate drifts down as the inflation schedule decays. The tool reads the live figure
  on-chain (`solprofits pools`).
* For 1 SOL that means **≈ 1.06–1.08 SOL after a year** and ≈ 1.33–1.46 SOL after five, if rates hold.
  See [docs/STRATEGY.md](docs/STRATEGY.md#5-what-to-expect-illustrative-not-a-promise).
* There's no safe way to grow 1 SOL faster. The design rejects trading, memecoins, arbitrage/MEV bots, leverage
  loops, LPs and "high-yield" vaults, each with its reason in [STRATEGY.md](docs/STRATEGY.md#2-options-considered).
* Growth is measured in SOL. Staking does not protect against SOL's dollar price falling.

## High-risk mode: memecoin momentum bot

At your request there's also a separate, opt-in bot that targets +100% per trade by trading trending
memecoins (`node src/cli.ts bot …`). **Expect to lose money with it.** Its checks guard against scams, bugs and
misdirected transactions, not against the market. Read [docs/MEMECOIN_BOT.md](docs/MEMECOIN_BOT.md) and
paper-trade first (`bot paper`). It runs 24/7 on your own machine or server
([deploy/solprofits-bot.service](deploy/solprofits-bot.service)). The staking tool below is unaffected.

## How a deposit is kept safe

1. **Verify.** Each pool is re-verified on-chain on every run:
   * owner program, mint, mint authority equals the derived PDA, bump seed, no freeze authority
   * supply consistency, reserve, fee account
   * policy limits: fee caps, *pending* fee hikes, staleness, TVL, gated exits, token-value drops
2. **Quote exactly.** An integer replica of the program's own math says exactly how many tokens you'll get.
   A 0.01 SOL fee reserve always stays liquid.
3. **Make the program enforce it.** `DepositSolWithSlippage` reverts on-chain if fewer tokens than the quote
   minus 0.2% would be minted.
4. **Firewall the bytes.** The exact message to be signed is decoded and checked independently:
   * only 4 programs are allowed (compute budget, ATA, SPL token, stake pool)
   * there's one signer
   * pool tokens may only go to the wallet's own (re-derived) account
   * fees are capped
   * **there's no code path that can send SOL anywhere else**
5. **Simulate the final bytes.** The simulated balance changes must match the quote within 1 bps.
6. **Sign deliberately.** Signing needs `--execute` and a typed confirmation. A kill switch, a genesis-hash check
   (mainnet only) and expiry-aware confirmation guard the send, and a ledger records every signature.
7. **Monitor read-only.** `monitor` needs only the public address and runs unattended (GitHub Actions workflow
   included). It pages on compromise signals, pending fee hikes, value drops and exit-liquidity problems.

## Quick start

```bash
npm ci
```

```bash
export WALLET_ADDRESS=<your wallet's public address>
```

```bash
node src/cli.ts selfcheck
```

```bash
node src/cli.ts plan
```

```bash
SOLANA_KEYPAIR_PATH=~/.config/solana/solprofits.json node src/cli.ts deposit --execute
```

Then check on it with `node src/cli.ts status` (or `monitor`). The full procedure, alert playbook and exit
paths are in [docs/RUNBOOK.md](docs/RUNBOOK.md).

| Command | Key needed? | What it does |
|---|---|---|
| `status` | no | Wallet value in SOL, positions, pool health, P&L since the first snapshot |
| `pools` | no | Verify and rank the allowlisted pools (APY, TVL, fees, issues) |
| `plan` | no | Exact deposit plan, simulated against the chain |
| `monitor` | no | Health checks; exit 0 / 1 (warning) / 2 (critical) |
| `selfcheck` | no | Validates RPC, cluster, program and decoders against live data; simulates a deposit |
| `deposit [--pool S] [--amount SOL] --execute` | yes | Stake idle SOL (dry run without `--execute`) |
| `withdraw [--pool S] [--amount T] --execute` | yes | Redeem for SOL instantly from the pool reserve |

**Configuration:**

* Environment: `SOLANA_RPC_URL`, `WALLET_ADDRESS`, `SOLANA_KEYPAIR_PATH` or `SOLANA_KEYPAIR`, `SOLPROFITS_HALT`.
  See [src/config.ts](src/config.ts).
* Limits: [config/policy.json](config/policy.json), documented in
  [RUNBOOK §7](docs/RUNBOOK.md#7-policy-reference-configpolicyjson).
* Pools: [config/pools.json](config/pools.json).

## Verification status

* **156 automated tests** (`npm test`, covering the staking tool and the bot) plus a strict type-check
  (`npm run typecheck`). Cross-checks:
  * Transactions, instructions, PDAs, ATAs, signatures and base58 are **byte-for-byte identical** to
    `@solana/web3.js`, `@solana/spl-token`, `@solana/spl-stake-pool` and `bs58`.
  * Account decoders round-trip through the **official** layouts.
  * Fee and deposit/withdraw math follows the program source (spl-stake-pool 2.2.0).
* End-to-end tests drive the real CLI against a mock RPC. The mock decodes transactions with the official
  libraries and executes them: refusals, deposit, idempotent re-run, monitor paging, full withdrawal.
* **Not yet exercised against mainnet.** The environment this was built in blocks Solana RPC hosts, so the
  on-chain pool addresses and the deployed program's support for the slippage-guarded instructions are
  unconfirmed. `selfcheck` confirms both, read-only, before any money moves. The tool refuses to sign if
  the guarded instruction is unsupported, unless you change policy.

**Supply chain:** runtime dependencies are only `@noble/curves` and `@noble/hashes`, both audited and
dependency-free, pinned exactly, with a lockfile and `ignore-scripts=true`. The Solana SDKs are dev-only and
used solely to cross-check this code.

**Layout:**

* `src/solana`: encoding, transactions, RPC, decoders
* `src/core`: policy, pool verification, planner, firewall, executor, monitor, ledger
* `test/`: the suite above
* `docs/`: strategy and runbook

*Not financial or tax advice.*
