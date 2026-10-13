# Plan 6 — Agent Chat, Accounts and Metering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person connects a passkey wallet, is signed in without a prompt, and chats with an agent that reads Iter, proposes actions, and has each one confirmed in the wallet's own card. Every model call is paid for from a credit balance, and chats are kept per wallet address.

**Architecture:** Four layers, each its own package or folder. `packages/db` is Drizzle over Postgres, or PGlite when `DATABASE_URL` is unset outside production; migrations are embedded in a generated module so they work inside a bundle. `packages/agent` turns the protocol registry into AI SDK tools: reads run on the server, actions are client-side tools with no `execute`, so the model can only propose them. `apps/web/lib/server/chat.ts` places a hold before the model call and settles after it, answering 402 when credit is short. In the browser, `runAction` builds the transaction from the typed intent through the `ProtocolAdapter`, simulates it, and hands each step to the wallet frame, which decodes and displays it itself.

**Tech Stack:** `ai` 7, `@ai-sdk/react` 4, the AI Gateway (`moonshotai/kimi-k3` default), Drizzle 0.45, PGlite, postgres.js, streamdown, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-18-agentic-trading-chat-design.md` §7 chat, §7.4 and D12 the prompt input, §9 accounts, credit and metering, §11 testing, §14.4 rate limits.

## Global Constraints
- Branch `feat/plan-6-agent-chat` from `feat/plan-5-iter-actions`.
- Money is integer micro-USD; token prices are integer pico-USD per token. No floats touch an amount. Rounding is always up, against the account.
- The model is untrusted. It never supplies calldata, a contract address or base units, and a tool result never causes a signature: only the wallet's card does.
- An action found in reloaded history is never run. Runs start only from `onToolCall`.
- Model ids come from the live gateway list filtered by `MODEL_ALLOWLIST`; a client-chosen id outside it is refused.
- Test hooks require BOTH a non-production build AND `E2E_TEST_HOOKS=1`.

---
- [x] **Task 1: `packages/db`.** Schema (users, nonces, sessions, credit accounts, ledger, holds, chats, messages), embedded migrations with a drift test and an advisory lock, `auth.ts`, `credits.ts` (`applyCredit` idempotent by `ref`, `placeHold`, `settleHold`, `releaseStaleHolds`), `chats.ts`, `scripts/adjust-credit.ts`.
- [x] **Task 2: `packages/agent`.** `pricing.ts` (`parsePrice`, `costMicrousd`, `holdMicrousd`, `formatUsd`), `models.ts` (live list, allowlist, default), `prompt.ts`, `tools.ts` (`buildTools` from adapters; `clientToolNames`), `agent.ts` (`createTradingAgent`, 8 steps, 4096 output tokens).
- [x] **Task 3: sign-in.** `packages/wallet/src/signIn.ts` (the exact template the frame signs silently), `/api/auth/{nonce,verify,session,logout}`, a nonce bound to a pre-session cookie, same-origin check, rate limits.
- [x] **Task 4: the metered chat route.** `lib/server/chat.ts` `handleChat`: validate, resolve the model, hold, stream with `createAgentUIStreamResponse`, settle on end, release on error, persist messages, `x-chat-id` header. `/api/chats`, `/api/chats/[id]`, `/api/models`.
- [x] **Task 5: the action runner.** `lib/chat/runAction.ts` (build, simulate with deferral, approval for the exact amount, action, receipt; denied, reverted and failed are results, not exceptions) and `lib/chat/actionRuns.ts` (an external store keyed by tool call).
- [x] **Task 6: the chat UI.** `ChatView`, `ToolParts` (read line, quote card, action card with the wallet's card inside it, result card, top-up card), `PromptInput` with the protocol and model pills, `Sidebar` (new chat, search, history, credit), `AppShell`, `/c/[id]`, silent sign-in in `useAppSession`.
- [x] **Task 7: end to end.** `lib/server/mockModel.ts` (a scripted model), `/api/dev/credit`, `e2e/chat.spec.ts`: no credit gives 402 and a top-up card; a reply streams, is charged and reopens from the sidebar; a server tool round-trips; an order is approved then placed and the signed calldata equals the intent; Deny signs nothing; the pills.
- [x] **Fixed on the way:** the wallet frame pages read `window` while rendering and failed hydration (`lib/useEmbedded.ts`); PGlite could not create its folder on a fresh checkout; "New chat" did nothing while a new chat was open (`lib/chat/newChat.ts`).
- [ ] **Not in this plan:** the credit top-up rails and `/settings/credit` (the 402 card says none is switched on); the MCP adapter and the Custom tier; Iter liquidity and launch actions; the Aurora Intents funding route.

## Closed on review
An independent security review and code review of this plan found, and commits `8170d34`, `93248c0` and the one after them fixed:
- **Billing.** The hold covered one model call while the loop allowed eight, and the guard fired after the overrun. Replaced by a budget that refuses to start a step whose worst case does not fit (spec §14.2, amended). Holds orphaned by a killed request are now released.
- **The action runner.** A finished action could start a billed request after its chat was closed; an unanswered wallet prompt hung forever; two actions in one reply raced for the wallet. Runs now queue, belong to their view, and can be cancelled. Tools that only open another screen no longer trigger a follow-up request.
- **The chat route.** An action abandoned mid-way made every later message in that chat fail. Unexpected errors were bare 500s. A second turn's reply collided on save. A gateway outage stalled every request.
- **Exposure.** Test hooks could be switched on by a stray variable on a hosted deployment. Model-written markdown could load any image. The sign-in message was not bound to a site. Same-origin checks trusted a forwarded host header.
- **Interface.** The markdown renderer was never styled (a Tailwind path that does not exist under pnpm). The model and protocol choice was per browser, not per chat. Sign-in ran twice and had no retry. The pickers and the mobile menu lacked keyboard support.
An independent verifier then confirmed each fix against the code and the tests.

## Deviations from the spec
- D1 names AI Elements for the chat UI. Only `conversation` and `message` are vendored. The prompt input and the tool cards are this app's own, because the pills (D12) and the embedded wallet card have no AI Elements counterpart.
