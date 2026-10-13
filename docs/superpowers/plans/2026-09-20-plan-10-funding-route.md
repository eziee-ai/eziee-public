# Plan 10 — Aurora Intents Funding Route (gated) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The server can quote, start and follow a cross-chain deposit or withdrawal through Aurora Intents, and the interface knows for which networks that exists. For the two testnets it does not, so nothing is shown in v1 (spec §8.1).

**Architecture:** `FundingRoute` is the seam (spec §8.1). `createAuroraIntents` implements it against the published Swap API reference, whose OpenAPI was read for this plan: `GET /api/tokens/{apiKey}`, `POST /api/quote/{apiKey}`, `POST /api/deposit/submit/{apiKey}`, `GET /api/status/{apiKey}`. The key is in the URL path, so every call is made by the server, and no failure ever repeats an error's text, which could contain that URL. The two addresses that decide where money goes are not the page's to choose: funds coming in are delivered to the signed-in account, and funds going out are refunded to it.

**Spec:** §8.1; build-order milestone 9.

## Global Constraints
- Branch `feat/plan-10-funding-route` from `feat/plan-9-credit-topup`.
- A destination network must be in `AURORA_BLOCKCHAIN` (chain id to the API's network name). RISE and Arc testnets are not, so `supportsDestination` is false for both.
- `appFees` is never sent (no integrator fee), as the spec's default.
- Quotes are `EXACT_INPUT`, `ORIGIN_CHAIN` deposits, with `refundTo` always set.

---
- [x] **Task 1:** `lib/funding/types.ts`: `FundingRoute`, `FundingQuoteRequest`, `FundingQuote`, `FundingStatus`.
- [x] **Task 2:** `lib/server/funding/aurora.ts`: the client, strict response schemas for the fields used, a token list cached ten minutes, assets resolved from that list (an app asset by network and contract address, the other by asset id), and refusal before any quote is requested of an unsupported network or asset, a zero amount, slippage outside 0.01% to 50%, or an address containing anything an address cannot.
- [x] **Task 3:** routes `GET /api/funding` (which networks), `GET /api/funding/sources`, `POST /api/funding/quote`, `POST /api/funding/submit`, `GET /api/funding/status`: signed-in, same-origin for writes, rate limited, bodies capped.
- [x] **Task 4:** `useFundingSupport(chainId)`: the gate the two interface sections will render behind.
- [ ] **Not in this plan:** the "From another chain" section on Deposit and the "To another chain" section on Withdraw. No network this app serves can show them, so they could not be looked at or tested end to end; they belong with the first mainnet. This client has not been run against the live service, which needs a key: it is tested against the documented shapes only.
