# Plan 4 — Permission Rule Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The wallet frame signs a protocol action silently only under a rule the user made in the frame, and offers Deny, Allow once and Always allow… on everything else.

**Architecture:** `packages/wallet` still imports nothing else in the repo: the app injects `decodeAction` and `decodeApproval` from its bundled protocol registry through `configureWallet`. `policy.ts` becomes a static floor (only reads are silent; transfers, typed data, messages and authorizations always ask). `evaluate.ts` layers the decoder and the user's rules on top. Rules and per-day counters live in IndexedDB on the frame origin; a daily cap is reserved atomically before signing and never refunded.

**Tech Stack:** as Plan 1, plus fake-indexeddb for the store tests.

**Spec:** `docs/superpowers/specs/2026-09-18-agentic-trading-chat-design.md` §5.3, §5.4 (`/wallet-frame/confirm` card, `/wallet-frame/rules`), §9.1 sign-in template, build-order milestone 5.

## Global Constraints

- Branch `feat/plan-4-rule-engine` from `feat/plan-3-transfers`.
- DEFAULT DENY: every function answers "ask" for anything it does not positively recognise. A decoder that throws means "unknown".
- INVARIANT: no request is signed without a matching unexpired rule evaluated on frame-decoded calldata, or a real click inside the confirm frame.
- INVARIANT: the confirm card's text comes only from frame-decoded calldata and onchain reads.
- The ported key-handling files (`mera.ts`, `meraSession.ts`, `webauthnClient.ts`) are not edited.

---

### Task 1: Rule model (pure) — `frame/rules.ts`
- [x] `Rule`, `validateRule`, `matchAction`, `matchApproval`, `dayKey`; 42 table tests. Beyond the spec's text: a rule carries the **account** it was made for, and a rule token may be `"native"`.

### Task 2: Rule store — `frame/ruleStore.ts`
- [x] Database `wlt.rules` (not `wlt.mera`: that one is opened at a fixed version by ported code). `reserveSpend` checks the cap and writes the total in one readwrite transaction; a concurrency test proves ten racing reservations never pass a cap.

### Task 3: Evaluation and wiring
- [x] `frame/evaluate.ts`: floor → sign-in template → approval → decoded action → rules → atomic reservation. `isSignInMessage` accepts exactly the four-line template for this account, issued within ten minutes.
- [x] `policy.ts` reduced to the floor. **Behaviour change from the ported code:** calls into venue contracts and ANY text message used to sign silently; now nothing but reads does.
- [x] `config.ts`: `knownContracts` replaced by injected `decodeAction` / `decodeApproval`. `host.ts` evaluates against the frame's own session account. `signer.endSession` deletes session-scoped rules.
- [x] `apps/web/lib/walletSetup.ts` builds the registry from bundled manifests and injects its decoders.

### Task 4: The permission card and the rule list
- [x] `frame/scope.ts` (eligibility, prefilled draft, cap parsing) and `frame/allow.ts` (`allowAlways` re-decodes the transaction in the frame and refuses any rule that does not describe exactly that action), both tested.
- [x] `PresentParams.variant` gains `"card"`. `/wallet-frame/confirm` renders `PermissionCard` for it: decoded restatement, Deny, Allow once, Always allow… with per-transaction and per-day limits and an expiry.
- [x] `/wallet-frame/rules` lists this account's rules with today's usage, revokes one, and ends the session. `/settings/permissions` embeds it and lists what always asks.

### Task 5: Gate and review
- [x] Full gate green; e2e covers the Permissions page and ending the session from the frame.
- [x] Independent security review, and its findings addressed:
  - **Critical:** a transaction carrying any field a decode does not cover (an EIP-7702 `authorizationList` above all) is no longer decodable, so it is never shown as "a swap" and never silent. `normalise` allows only `from`, `to`, `data`, `value`, `gas`.
  - **High:** the card is keyed by the presented request. A swapped request is a fresh card: editor closed, limits cleared, buttons dead for 750 ms, and a line saying the request changed. Token metadata is keyed by chain.
  - **High (accepted risk, stated to the user):** a rule caps what goes IN. The wallet knows no prices, so inside a rule a compromised app could make bad trades up to the daily limit. A declared minimum of zero is refused outright, the limit editor says this in plain words, and the owner should sign off on it.
  - **Medium:** a session rule carries the stamp of the session it was made in and is dead in any other, even if deleting it failed. Rule ids must be UUIDs. The sign-in window is one-sided (ten minutes old at most, one minute ahead at most).
- [x] End-to-end against the real frame pages with Iter's real order action: Always allow saves a rule and later orders inside it sign silently, then ask again over either limit; nothing value-moving is silent with no rule; the delegation attack and the request-swap attack are both exercised.
