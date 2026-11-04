# Runbook

Run every command from the repo root. `solprofits` below means `node src/cli.ts` (Node ≥ 22.18).

## 1. One-time setup

```bash
npm ci
```

```bash
export SOLANA_RPC_URL="https://api.mainnet-beta.solana.com"   # or a private RPC URL (recommended)
```

```bash
export WALLET_ADDRESS="<the wallet's PUBLIC address>"
```

**Key handling.** Pick one option. Never paste a private key into a chat, an issue or a commit.

* **Option A (recommended): you hold the key.** Keep the keypair file outside this repo with `chmod 600`, and
  run the `--execute` steps yourself:
  `export SOLANA_KEYPAIR_PATH=~/.config/solana/solprofits.json`
* **Option B: an agent or automation operates.** Store the key as a secret named `SOLANA_KEYPAIR`, either in the
  cloud environment's settings or in your secret manager (JSON byte array or base58). The tool deletes the
  variable from its own environment as soon as it reads it.

Use a **dedicated wallet** holding only the SOL you want this tool to manage.

## 2. First deposit (about 5 minutes)

1. `solprofits selfcheck`: must end with **All checks passed**. It checks, against the live chain:
   * the genesis hash (you're on mainnet)
   * the stake pool program deployment and its upgrade authority
   * that each pool decodes consistently: the derived withdraw authority equals the mint authority, and the
     pool's token supply matches the mint
   * that a deposit from your wallet simulates and reproduces the exact quote
2. `solprofits pools`: review APY, TVL, fees and any `[warning]` lines.
3. `solprofits plan`: shows exactly how much is deposited, how many pool tokens you get, the on-chain enforced
   minimum, the entry cost and the SOL kept liquid. It is simulated, and nothing is signed.
4. `solprofits deposit --execute`: shows what the transaction does, *decoded from the bytes to be signed*, and
   waits for you to type `yes`. Use `--yes` only in automation you already reviewed.
5. `solprofits status`: confirms the position and records the first ledger snapshot (the P&L baseline).

Running `deposit` again is safe. It only deposits SOL above the reserve and otherwise prints "Nothing to do".

## 3. Ongoing operation

* **`solprofits monitor`** needs only the public address. Run it on a schedule, e.g. the provided GitHub Actions
  workflow, which runs every 6 hours once merged to the default branch and given a `WALLET_ADDRESS` repository
  variable. Exit code 0 = healthy, 1 = warnings, 2 = critical (act now), 3 = the check itself failed
  (e.g. RPC down).
* **`solprofits status`** weekly. Each run adds a snapshot, which gives a multi-epoch trailing APY and P&L in SOL.
* **New SOL arrives:** `solprofits deposit --execute` stakes it into the existing position.
* **Before any change:** re-run `selfcheck`.

## 4. Alert playbook

| Alert code | Meaning | Action |
|---|---|---|
| `wrong-cluster` | RPC isn't mainnet-beta | Fix `SOLANA_RPC_URL`. Signing is refused until fixed. |
| `value-floor` | Total value is below `monitorMinTotalSol` | **Investigate immediately.** Check recent transactions in an explorer. If anything you didn't do appears, assume the key is compromised: withdraw and move the funds to a fresh wallet (§6). |
| `ata-delegate` / `ata-close-authority` | Someone was approved to move or close your pool tokens | You didn't do this, so treat it as a compromise (§6). |
| `ata-frozen`, `mint-freeze` | Tokens are frozen, or can be | Shouldn't be possible for SPL stake pools; investigate and avoid the pool. |
| `value-decreased` | Pool token value fell over an epoch | Possible slashing or exploit. Read the pool's announcements; consider `withdraw --execute`. |
| `withdrawal-fee-increase` / `epoch-fee-increase` | The pool manager scheduled a higher fee (applies in 1–2 epochs) | If it's above policy, exit **before** it applies: `withdraw --execute`, then deposit into the next-best pool. |
| `withdraw-gated` | SOL exits now need the pool authority's signature | You can't exit via `WithdrawSol`. See §5 alternatives. Don't add funds. |
| `exit-liquidity` | The reserve can't cover an instant exit of your position right now | Usually temporary. Only matters if you need to exit now (§5). |
| `pool-stale` | The pool hasn't been updated for this epoch | Normal for minutes after an epoch boundary. If it lasts more than 1 epoch, treat it as operational risk. |
| `program-upgraded` | The stake pool program code changed recently | Read the release notes and re-run `selfcheck` before depositing more. |
| `low-fee-reserve` | Not enough liquid SOL to pay for an exit | Send a little SOL (≥ 0.01) to the wallet. |

## 5. Exits

* **Normal / emergency exit:** `solprofits withdraw --execute`. It redeems the whole position from the reserve
  at the pool rate, pays the pool's instant-withdrawal fee, closes the token account and refunds its rent.
  Partial: `--amount <tokens>`.
* **If the reserve is too small** (`SolWithdrawalTooLarge` / `exit-liquidity`):
  1. Retry later. Reserves refill as deposits arrive and the pool rebalances.
  2. Exit partially, as much as the reserve allows.
  3. Use the pool's *stake withdrawal* in its official UI. You receive a stake account that keeps earning, which
     you can deactivate and withdraw after a cool-down epoch.
  4. As a last resort, swap the LST for SOL on a DEX aggregator at market price. This is the only path exposed to
     depegs and slippage.
* **Kill switch:** `touch HALT` in the repo root, or set `SOLPROFITS_HALT=1`. All signing is refused. Read-only
  commands keep working. Delete the file to resume.

## 6. Key compromise or rotation

The tool deliberately **cannot send SOL to another address**: its transaction firewall only allows deposits into
allowlisted pools and withdrawals back to the same wallet. To move funds to a new wallet:

1. Create a new wallet offline (e.g. `solana-keygen new --outfile <path>` on a trusted machine).
2. `solprofits withdraw --execute` from the old wallet, to get SOL back.
3. Transfer the SOL with your normal wallet software (`solana transfer …` or a hardware wallet).
4. Update `WALLET_ADDRESS` / key configuration and `deposit --execute` from the new wallet.

## 7. Policy reference (`config/policy.json`)

Unknown keys are rejected, so a typo can't silently disable a limit.

| Key | Default | Meaning |
|---|---|---|
| `cluster` | `mainnet-beta` | The RPC's genesis hash must match before anything is signed. |
| `reserveSol` | `0.01` | SOL always kept liquid for fees, including an emergency exit. Minimum 0.005. |
| `minDepositSol` | `0.05` | Smaller deposits aren't worth a transaction. |
| `maxSolPerTransaction` | `2` | Hard cap per transaction. It protects against pointing the tool at the wrong (bigger) wallet. |
| `slippageBps` | `20` | Tolerance between the exact quote and the **program-enforced** minimum output. |
| `maxDepositCostBps` | `30` | Max value lost on entry (deposit fee and rounding). |
| `maxSolDepositFeeBps` | `30` | Pools charging more for SOL deposits are excluded. |
| `maxSolWithdrawalFeeBps` | `50` | Pools charging more for instant exits are excluded: an expensive exit isn't safe. |
| `maxEpochFeePct` | `10` | Max share of staking rewards a pool may keep. |
| `minPoolTvlSol` | `100000` | Only large, established pools. |
| `maxPriorityFeeSol` | `0.0001` | Cap on the priority fee per transaction (base fee 0.000005 SOL is extra). |
| `minComputeUnitPriceMicroLamports` | `5000` | Floor price so transactions land without overpaying. |
| `aprSanityMaxPct` | `15` | Single-epoch APY above this is treated as noise and capped in scoring. |
| `switchMinAprGainPct` | `0.5` | Suggest switching pools only above this gain (pp/yr). |
| `monitorMinTotalSol` | `0.97` | Critical alert below this total value. Adjust it when you add or remove funds. |
| `requireSlippageGuardedInstructions` | `true` | Only use deposit/withdraw instructions with an on-chain minimum output. |
| `allowedStakePoolPrograms` | SPL stake pool | Programs a pool may be owned by. |

## 8. Adding a pool to the allowlist

Get the stake pool address and mint **from the issuer's official documentation** and add them to
`config/pools.json`. Then run `solprofits selfcheck` and `solprofits pools`. A wrong entry is excluded
(identity verification fails); it's never used. Prefer large, long-running pools whose manager differs
from the pools you already use.
