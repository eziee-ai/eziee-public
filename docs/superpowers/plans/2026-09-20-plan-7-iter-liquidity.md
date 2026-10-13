# Plan 7 — Iter Liquidity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person can add liquidity to one band of an Iter pool, withdraw a position and claim its fees from the chat, with the wallet describing each from the calldata.

**Architecture:** `BandPositionManager.addLiquidity(pool, band, baseAmount, quoteAmount)` names a pool, as the swap does, so it gets a first-party chain decoder that makes the factory vouch for the pool. It spends two tokens, which the rule engine already refuses to cover, so it always asks. `removeLiquidity(tokenId, recipient)` and `collect(tokenId, recipient)` name a position the manager resolves from its own storage, so the manifest declares them with the recipient pinned to the signer. The adapter exposes one chain decoder, `decodeIterWithChain`, which tries each first-party decoder in turn.

**Spec:** §6.1 actions and approvals; guideline §3 mechanical rules. Facts verified during this plan: the Arc position manager is a direct deployment (EIP-1967 implementation, beacon and admin slots all zero) and its `poolFactory()` is the manifest's `bandPoolFactory`; the manager, not the pool, pulls the depositor's tokens, so it is the approval spender; a live Arc pool's bands were read and a deposit built and decoded against them.

## Global Constraints
- Branch `feat/plan-7-iter-liquidity` from `feat/plan-6-agent-chat`.
- `build` never accepts calldata, a contract address or base units. Approvals are exact and only to a `router`-role contract.
- Every built transaction must decode back to its intent, asserted in tests.

---
- [x] **Task 1: the manifest rule.** Every `address` input of EVERY call must be accounted for, not only of spending calls: a withdrawal spends nothing and still pays out to an address. `cancelOrder` now explains `base` and `quote` under `ignore`.
- [x] **Task 2: manifest 0.3.0.** `removeLiquidity` and `collectFees`, recipient pinned; `positionManager` becomes an approval spender (`router`), in the manifest and in the vendoring script's role table.
- [x] **Task 3: `decodeIterAddLiquidity`.** Factory check; two spends, zero amounts omitted; launched coins flagged unlisted; null on a fake pool, attached value, nothing deposited, appended bytes, another function, a failed read.
- [x] **Task 4: actions.** `addLiquidity` (pool order enforced with a message that says so, band exists and is open, amounts that would mint zero shares refused, two exact approvals), `removeLiquidity` and `collectFees` (only for a position the wallet holds).
- [x] **Task 5: reads.** `bands` (answers in the pool's order whichever way it is asked) and `position` (principal, vested fees, fees forfeited by withdrawing now).
- [x] **Task 6: the app.** The wallet uses `decodeIterWithChain`; the prompt tells the model to read bands and positions first and what to disclose; an end-to-end test drives the three-step deposit and asserts the card shows both tokens and offers no rule.
- [ ] **Not in this plan:** `addLiquidityAcross` and `addLiquiditySingleSided`; `launchCoin` (AssetGenerator: a payable launch fee plus a listing payment in a second token, which needs its own decoder and a fee read); native-in swaps on RISE.

## Known limits, disclosed to the person by the agent
- Iter's `addLiquidity` has no minimum-shares argument. A band's ratio can move between the read and the deposit; the unused side is refunded, but the deposit lands at the ratio it finds.
- Withdrawing before fees vest forfeits the unvested part. The `position` read reports the amount.

## Closed on review
- A one-sided `addLiquidity` decoded with a single spend, which made it eligible for a rule the builder can never need, into a pool and band the card did not show. It no longer decodes, and the card shows the pool and band.
- Making the position manager approvable let an existing swap rule silently grant it an allowance. A rule now covers an approval only to the contract its own action calls.
- `removeLiquidity` is marked `alwaysAsk`: leaving early forfeits fees, and no rule should do that quietly.
- `addLiquidity` checks the pool's own spread gate before anyone pays for approvals, and `bands` reports the pair's reach and whether the percentages are final. Checked against a live Arc pool, whose ladder is scaled exactly to the pair's 0.1% reach.
