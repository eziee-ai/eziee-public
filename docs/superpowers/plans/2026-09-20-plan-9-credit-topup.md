# Plan 9 — Adding Credit with USDC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person adds credit by sending USDC from their passkey wallet, and sees it arrive, without anyone having to trust the page that said so.

**Architecture:** The browser only ever says "here is a transaction hash". The server reads the chain itself and credits what it finds there: a successful receipt, a `Transfer` log from the configured USDC contract, from the signed-in account, to the treasury, deep enough. `from` must be the signed-in account, so a hash copied from an explorer credits nobody else. Each log is credited once, keyed `<chainId>:<txHash>:<logIndex>`. The transfer itself goes through the wallet frame like any other, and a transfer always asks. Deposits in flight are remembered in the browser so a reload resumes checking them; losing that memory loses no money.

**Spec:** §14.3 (USDC rail), §14.1 (ledger, idempotency by `ref`).

## Global Constraints
- Branch `feat/plan-9-credit-topup` from `feat/plan-8-mcp-adapter`.
- No address is hardcoded. The treasury and each network's USDC contract are configuration, and the USDC address is checked against the chain (code, `symbol()`, `decimals()`) before a network is offered or a deposit counted.
- A node is believed only about the chain it really is (`eth_chainId` is checked before a receipt is trusted).
- USDC is credited one dollar per USDC, scaled from the token's own decimals, rounded down.
- A rail is listed only if it is configured AND built.

---
- [x] **Task 1: `lib/server/billing/usdc.ts`.** `usdcRailConfig`, `verifyUsdcToken`, `usdcToMicrousd`, `creditUsdcDeposit` returning `credited`, `already-credited`, `pending` (with confirmations) or `rejected` (with a reason a person can read).
- [x] **Task 2: routes.** `GET /api/billing` (credit, rails, verified payment networks, recent ledger) and `POST /api/billing/usdc` (same-origin, signed-in, rate limited, body capped). `listLedger` in `packages/db`.
- [x] **Task 3: the page.** `/settings/credit`: spendable credit and what is held, the USDC top-up (network, amount, a review that shows the full treasury address, the wallet's own confirmation), deposits on their way, recent activity with test credit marked. Linked from the sidebar's credit block and from the out-of-credit card.
- [x] **Task 4: server-side RPC.** `RPC_URL_<chainId>` for the server's reads. It also makes the end-to-end suite hermetic: the test server reads `e2e/mockChainServer.mjs`, not a live testnet.
- [x] **Task 5: end to end.** A deposit followed from the wallet's confirmation to spendable credit; nothing is credited before the server's chain has the transaction; the same hash credits once; another wallet cannot claim it.
- [ ] **Not in this plan:** the card rail (Stripe Checkout and its webhook) and the utility-token rail. Neither is listed as available, whatever is configured. The token rail prices the token on its own market, which does not exist yet.

## Closed on review
- Testnet USDC is free, and the credit it buys spends real model money. A testnet network is now refused unless `BILLING_ALLOW_TESTNET_CREDIT=1`, and one deposit is credited for at most `BILLING_MAX_PER_TOPUP_MICROUSD` ($500), checked on the page before anything is sent. The cap is on the whole transaction: a verifier found it had been applied to each transfer log separately, which several transfers in one transaction would have walked past.
- A receipt is credited only while its block is still the chain's block at that height, the block trusted is recorded on the ledger row, and the default depth is 12, not 3. A reorg deeper than the configured depth is still not reversed: there is no sweep that writes a compensating row.
- A deposit could vanish from the page if it was left mid-send, with no way back. Any transaction hash can now be checked from the page, and a record that will never confirm can be put away.
- Polling continues in a background tab, backs off after failures and obeys `Retry-After`. The token is verified once per process, from a node that is the right chain. An unreachable network is reported as unreachable, not as "nothing is switched on".
- A transfer that reached the treasury from a different address gets its own explanation, and the page says to send only from this wallet.

## For the operator before switching this on
- The treasury address receives real money on a mainnet. Decide who holds its key (spec §14.4 asks for a multi-sig) before setting it.
- Credit bought on a testnet is recorded as test credit but spends like any other. The rail ignores testnets unless you set `BILLING_ALLOW_TESTNET_CREDIT=1`; both networks this build serves are testnets.
- Money sent to the treasury by any route other than a direct transfer from the signed-in wallet (an exchange withdrawal, a contract wallet) is received and cannot be credited automatically. Expect support requests with a transaction hash.
