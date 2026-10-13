# Plan 5 — Iter Actions and Decoders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Iter's swap, limit order and cancel can be built from a typed intent, simulated, decoded by the wallet from calldata, and covered by a rule.

**Architecture:** Orders decode declaratively from the manifest. The swap cannot: `BandSwapRouter.swap(pool, amountIn, quoteToBase, recipient, minOut)` names a pool, not tokens, so a first-party decoder reads the pool's base and quote and requires the factory to vouch for that very pool. The wallet's injected decoder is therefore awaitable. Tokens off the protocol's reviewed list are flagged rather than refused, so a person still sees what a launched-coin trade does, and nothing may make or match a rule for it.

**Spec:** §6.1 actions, approvals and slippage; §7.2 steps 1–2; build-order milestone 6. Facts verified onchain during this plan: limit price is 1e8 fixed-point; a buy's amount is in the quote token.

## Global Constraints
- Branch `feat/plan-5-iter-actions` from `feat/plan-4-rule-engine`.
- `build` never accepts calldata, a contract address or base units from its caller. Approvals are exact and only to a `router`-role contract.
- Every built transaction must decode back to its intent (round trip), asserted in tests.

---
- [x] **Task 1:** `Spend.listed`, `receive.listed`, `DecodedAction.unlisted`; decoder flags instead of nulling.
- [x] **Task 2:** Iter manifest 0.2.0: `placeOrder` (`limitBuy`, `limitSell`), `cancelOrder`; `matchingEngine` becomes an approval spender. The vendoring script preserves hand-authored `actions` and `version`.
- [x] **Task 3:** `decodeIterSwap` with the factory check; null on a fake pool, a foreign recipient, attached value, zero amount, appended bytes, a failed read.
- [x] **Task 4:** `swap`, `placeOrder`, `cancelOrder` actions with `simulate` (defers a call that only fails for want of the approval before it).
- [x] **Task 5:** wallet: awaitable decoders, `unlisted` never rule-eligible; the app injects registry decode then the Iter swap decoder.
- [ ] **Not in this plan:** `addLiquidity` / `removeLiquidity` (BandPositionManager) and `launchCoin` (AssetGenerator). Native-in swaps on RISE (wrap first). A fork test against live pools: Arc's pools hold launched coins only, so a listed-to-listed swap has no live pool to fork today.
