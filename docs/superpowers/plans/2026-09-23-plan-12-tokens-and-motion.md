# Plan 12: Token management and chat motion

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Give the chat visible, bounded model-token usage; put credit where the person types; let the wallet show, pin, hide and add tokens; and animate the chat's pending and finished states.

**Architecture:** Usage and trimming live on the server (`packages/agent` and `apps/web/lib/server/chat.ts`) and reach the browser as message metadata, so the UI only renders what the server says it did. Wallet tokens are a client concern: a per-wallet local store of custom tokens and preferences, a verifier that reads the chain before trusting an address, and a page that lists balances. Motion is CSS keyframes with a reduced-motion switch; components only toggle classes.

**Tech Stack:** Next.js 16 App Router, React 19, AI SDK 7 (`createAgentUIStream`, `messageMetadata`), viem 2, wagmi 2, TanStack Query 5, Tailwind v4, Vitest 2, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-18-agentic-trading-chat-design.md` (§7 chat, §14.2 metering) and `DESIGN.md` (motion: functional feedback 120–180 ms; continuous animation only for real pending work; reduced motion respected; no theatrical thinking animation).

## Global Constraints

- Branch `feat/plan-12-tokens-motion` in `/Users/hyungsukkang/orca/projects/AI-finance-agent-worktree-5`. Never touch the main checkout. Never push.
- Money is integer micro-USD as strings in JSON. Token counts are integers. No floats in billing.
- The model never receives an address the registry did not supply. Custom tokens are display-and-withdraw only and are never added to the model's tools. Say so in the UI.
- No hardcoded token addresses. A custom token is verified onchain (bytecode, `symbol`, `name`, `decimals`) before it is stored.
- The saved transcript is the FULL history plus the new reply. Trimming affects only what the model is sent.
- Every new animation is disabled under `prefers-reduced-motion: reduce`. Durations 120–200 ms for transitions; loops only while work is pending.
- Copy: short, plain, one idea per sentence. "onchain" is one word.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. No TODO, `.skip`, `.only`.
- Gate for every task: `pnpm typecheck && pnpm lint && pnpm test`, and the relevant e2e (`cd apps/web && pnpm e2e -- <spec>`; Playwright starts its own server on port 3100).

---

### Task 1: Context window and usage in message metadata

**Files:**
- Modify: `packages/agent/src/models.ts` (`AvailableModel`, `availableModels`)
- Modify: `packages/agent/src/models.test.ts`
- Modify: `packages/agent/src/budget.ts` (expose summed usage)
- Modify: `packages/agent/src/budget.test.ts`
- Modify: `apps/web/lib/server/chat.ts` (`ChatMetadata`, `messageMetadata`)
- Modify: `apps/web/lib/server/chat.test.ts`

**Interfaces:**
- Produces: `AvailableModel.contextWindow: number` (tokens; `DEFAULT_CONTEXT_WINDOW = 128_000` when the gateway omits it or it is not a positive integer).
- Produces: `Budget.usage(): { inputTokens: number; outputTokens: number; cacheReadTokens: number }` (sum over steps).
- Produces: `ChatMetadata.usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number }`, `ChatMetadata.contextTokens?: number` (the estimated prompt size of the turn as sent), `ChatMetadata.contextWindow?: number`. All on the `finish`/`abort` part, alongside the existing `costMicrousd`.

- [x] **Step 1: Failing tests.** In `models.test.ts`: a listing with `context_window: 1000000` yields `contextWindow: 1000000`; a listing without it yields `128000`; `"context_window": "big"` yields `128000`. In `budget.test.ts`: after `add({inputTokens: 10, outputTokens: 5, inputTokenDetails: {cacheReadTokens: 4}})` twice, `usage()` is `{inputTokens: 20, outputTokens: 10, cacheReadTokens: 8}`. In `chat.test.ts`: the finish metadata of a scripted reply carries `usage`, `contextTokens > 0` and `contextWindow`.
- [x] **Step 2: Run; expect RED.** `pnpm --filter @repo/agent test`, `pnpm --filter @repo/web test -- chat`.
- [x] **Step 3: Implement.** In `models.ts`, read `context_window` from the listing next to `pricing`; in `budget.ts` sum the steps; in `chat.ts` extend `messageMetadata` for `finish`/`abort` with `usage: budget.usage()`, `contextTokens: promptTokens` (the value already computed for the hold estimate; keep it in a local), `contextWindow: model.info.contextWindow`. The Jev pre-run path (`prerun`/`speculation`) uses the same `messageMetadata`, so it gets them for free; confirm with the existing pre-run tests.
- [x] **Step 4: Run; expect GREEN.**
- [x] **Step 5: Commit** `feat(agent,web): report each reply's tokens, its context size and the model's window`.

### Task 2: History trimming

**Files:**
- Create: `packages/agent/src/history.ts`
- Create: `packages/agent/src/history.test.ts`
- Modify: `packages/agent/src/index.ts` (export)
- Modify: `apps/web/lib/server/chat.ts`
- Modify: `apps/web/lib/server/chat.test.ts`

**Interfaces:**
- Produces: `trimHistory(input: { messages: UIMessage[]; maxTokens: number; estimate: (messages: UIMessage[]) => number }): { messages: UIMessage[]; dropped: number }`.
  Rules: the LAST message is always kept. Drop from the oldest end until `estimate(kept) <= maxTokens`. A cut may only land so that the first kept message has `role === "user"` (never start on an assistant message, so tool calls are never split from their results). If even the last user turn alone exceeds `maxTokens`, keep it anyway and report `dropped` for the rest (the hold estimate then decides).
- Produces: `contextBudget(contextWindow: number, reserved: number): number` = `min(contextWindow, 200_000) - reserved`, floored at 8_000. `reserved` = instructions + tools estimate + `MAX_OUTPUT_TOKENS`.
- Produces: `ChatMetadata.trimmed?: number` on the `start` part: how many leading messages were not sent to the model this turn.

- [x] **Step 1: Failing tests.** `history.test.ts`: (a) nothing dropped when under budget; (b) drops oldest pairs and starts on a user message; (c) never drops the last message; (d) an oversize last turn is kept with `dropped = n - 1`; (e) an assistant message with a tool part is dropped together with the user message before it. `chat.test.ts`: a chat of 60 short turns with a tiny injected budget (test hook or a small `contextWindow` on the injected model) sends the model fewer messages than it received (assert on the scripted model's captured prompt) and the start metadata has `trimmed > 0`; the saved transcript still has all 60 turns plus the reply.
- [x] **Step 2: RED.**
- [x] **Step 3: Implement.** In `chat.ts`: after validation, `const { messages: modelMessages, dropped } = trimHistory({ messages, maxTokens: contextBudget(model.info.contextWindow, reserved), estimate: (m) => estimatePromptTokens({ instructions, tools, messages: m }) })`. The hold estimate, the agent stream and the pre-run all take `modelMessages`. Persistence takes the original `messages` plus the response. Raise `MAX_MESSAGES` to 1_000 and reword `CHAT_TOO_LONG` to say a new chat is needed past that. `readJsonCapped` cap: keep as is unless the 1_000-message test exceeds it; if it does, raise it to 4 MB and say why in a comment.
- [x] **Step 4: GREEN.**
- [x] **Step 5: Commit** `feat(agent,web): send the model only the history that fits its window, and say how much was left out`.

### Task 3: Usage in the chat UI

**Files:**
- Create: `apps/web/components/chat/UsageChip.tsx`
- Create: `apps/web/lib/chat/usage.ts` (+ `usage.test.ts`)
- Modify: `apps/web/components/chat/ChatView.tsx`
- Modify: `apps/web/e2e/chat.spec.ts`

**Interfaces:**
- Produces: `chatUsage(messages: ChatMessage[]): { tokens: number; costMicrousd: bigint; replies: number; last?: { contextTokens: number; contextWindow: number } }` (pure; sums assistant metadata).
- Produces: `formatTokens(n: number): string` ("340", "1.2k", "1.0M").
- Produces: `<UsageChip usage={...} trimmed={n} />`: a `button` with `data-testid="usage-chip"` showing `"{tokens} tokens · {cost}"`; on click a popover (`role="dialog"`, closed by Escape and outside click, uses `useModalFocus`) with rows: this chat's tokens, cost, replies; context used on the last reply as `"8.1k of 1.0M"` with a thin bar; and, when `trimmed > 0`, the line "The first {trimmed} messages are no longer sent to the model. They stay in this chat."
- The per-reply line under each assistant message (`data-testid="message-cost"`) becomes `"{model} · {in}k in · {out} out · {cost}"` when usage is present, else the current text.
- A divider `data-testid="trim-divider"` ("Earlier messages are kept but no longer sent to the model") is rendered before message index `trimmed` when the latest assistant message's start metadata says `trimmed > 0`.

- [x] **Step 1: Failing tests.** `usage.test.ts` for sums and formatting. `chat.spec.ts`: after one scripted reply the chip shows a token count and cost; opening it shows the context row.
- [x] **Step 2: RED.**  - [x] **Step 3: Implement.**  - [x] **Step 4: GREEN.**
- [x] **Step 5: Commit** `feat(web): show what a chat has used, what the last reply's context was, and what was trimmed`.

### Task 4: Credit where the person types

**Files:**
- Create: `apps/web/components/chat/CreditChip.tsx`
- Create: `apps/web/lib/billing/repliesLeft.ts` (+ test)
- Modify: `apps/web/components/chat/PromptInput.tsx` (render the chip in the pill row)
- Modify: `apps/web/lib/session/useAppSession.ts` and `apps/web/app/api/auth/session/route.ts` (add `heldMicrousd` to `credit`)
- Modify: `apps/web/components/shell/Sidebar.tsx` (show "on hold" when `heldMicrousd > 0`)
- Modify: `apps/web/e2e/credit.spec.ts`

**Interfaces:**
- Produces: `repliesLeft(spendableMicrousd: bigint, replyCosts: bigint[], minHoldMicrousd: bigint): number | null` = floor(spendable / average(replyCosts)), or floor(spendable / minHold) when there are no costs yet; `null` when spendable is 0.
- Produces: `<CreditChip />` (`data-testid="credit-chip"`): `"{spendable} credit · about {n} more replies"`; `tone="warn"` when `n !== null && n < 5`; a link to `/settings/credit`. Hidden when not signed in.
- `MIN_HOLD` is already `BILLING_MIN_HOLD_MICROUSD`; expose it to the client through the session response as `credit.minHoldMicrousd` so the chip does not guess.

- [x] **Step 1: Failing tests.** Unit for `repliesLeft` (no costs; average; zero). `credit.spec.ts`: with dev credit of $0.05 the chip shows the balance and a replies estimate; after a reply it updates.
- [x] **Step 2: RED.**  - [x] **Step 3: Implement.**  - [x] **Step 4: GREEN.**
- [x] **Step 5: Commit** `feat(web): show credit and roughly how many replies it buys, next to the prompt`.

### Task 5: Wallet tokens: list, pin, hide, add

**Files:**
- Create: `apps/web/lib/tokens/customTokens.ts` (+ test): local store keyed `eziee:tokens:{chainId}:{address}`; `listCustomTokens`, `addCustomToken`, `removeCustomToken`; `useCustomTokens(chainId, account)` with `useSyncExternalStore`.
- Create: `apps/web/lib/tokens/tokenPrefs.ts` (+ test): pinned and hidden sets per `{chainId}:{account}`; `usePrefs`, `togglePin`, `toggleHide`.
- Create: `apps/web/lib/tokens/verifyToken.ts` (+ test with a stubbed client): `verifyToken(client, chainId, address, registry: Token[]) → { kind: "reviewed"; token } | { kind: "unreviewed"; token } | { kind: "not-a-contract" } | { kind: "not-erc20"; reason }`. Steps: checksum the address (`getAddress`, reject invalid); `getCode` must be non-empty; `multicall` (fallback to three `readContract` calls if the chain has no multicall3) for `symbol`, `name`, `decimals`; `decimals` must be 0–36; `symbol` trimmed to 20 chars and control characters removed; compare with `registry` by lowercase address.
- Modify: `apps/web/lib/transfer/useTransferAssets.ts`: accept `extra: Array<{address, symbol, name, decimals}>`; read their `balanceOf` for `account` (multicall or per-token), merge, and add `trust: "canonical" | "listed" | "unreviewed"` to `TransferAsset`.
- Modify: `apps/web/lib/transfer/withdrawForm.ts` (`TransferAsset.trust`), `apps/web/components/transfer/AssetList.tsx` (an "Unreviewed" pill on such rows), `WithdrawPanel.tsx` (pass custom tokens in).
- Create: `apps/web/app/(app)/tokens/page.tsx`, `apps/web/components/tokens/TokensPanel.tsx`, `AddTokenForm.tsx`.
- Modify: `apps/web/components/shell/Sidebar.tsx` (NAV: `{ href: "/tokens", label: "Tokens", icon: Coins }`).
- Modify: `apps/web/e2e/mockChainServer.mjs`: `eth_getCode` returns bytecode for the USDC address and for a second token address (`0x000000000000000000000000000000000000cafe`? No: use a fixed non-zero mock like `0x1111111111111111111111111111111111111111`) and `0x` for others; `eth_call` answers `symbol/name/decimals/balanceOf` per address (USDC and the second token "EURC", 6 decimals, balance 5 EURC); add multicall3 aggregate3 if the chain config lists it, else make sure the code path falls back to single reads.
- Create: `apps/web/e2e/tokens.spec.ts`.

**UI (TokensPanel):**
- Header: "Tokens" and the chain pills (same options as the chat's chain pill; selection stored in the chat selection so both agree).
- Rows: symbol, name, balance (`formatUnits`), a trust label (nothing for canonical/listed, "Unreviewed" for custom), pin and hide buttons (`aria-pressed`). Pinned rows first, then by balance, then symbol. Hidden rows collapse into "Hidden ({n})" with a Show toggle.
- Add form: an address input; the Check button runs `verifyToken`; the result card says one of: "Already on the reviewed list", "Not a contract on {chain}", "Not an ERC-20: {reason}", or, for unreviewed: symbol, name, decimals, and the sentence "Not on the reviewed list. eziee will show its balance and let you withdraw it. The assistant will not trade it." with an Add button. Loading state on Check; errors as `role="alert"`.
- Empty and disconnected states: "Connect to see your tokens" with the passkey button.

- [x] **Step 1: Failing tests.** Unit tests for the three libs (store round trip, prefs toggles, verifier branches with a stubbed client). `tokens.spec.ts`: signed in on the mock chain, the page lists USDC with its balance; pin it (row moves first and `aria-pressed=true` survives reload); hide it (moves under Hidden); add the second token by address → the unreviewed card → Add → it appears with the "Unreviewed" label and its balance; the Withdraw page lists it with the label.
- [x] **Step 2: RED.**  - [x] **Step 3: Implement.**  - [x] **Step 4: GREEN.**
- [x] **Step 5: Commit** `feat(web): a tokens page that lists, pins, hides and adds wallet tokens after an onchain check`.

### Task 6: Chat motion

**Files:**
- Modify: `apps/web/app/globals.css` (keyframes and the reduced-motion block)
- Create: `apps/web/components/chat/motion.tsx` (`StreamingCursor`, `PendingDots`, `StepProgress`, `CheckDraw`)
- Create: `apps/web/components/chat/motion.test.tsx` (StepProgress phase mapping, CheckDraw renders the animated class only when `animate`)
- Modify: `apps/web/components/chat/ChatView.tsx`, `ToolParts.tsx`, `apps/web/components/ai-elements/message.tsx`
- Modify: `apps/web/e2e/chat.spec.ts`

**Motion spec (from DESIGN.md):**
- `--motion-fast: 140ms`, `--motion-base: 180ms`, `--ease-out: cubic-bezier(.2,.7,.2,1)`.
- `.rise-in`: opacity 0→1, translateY 6px→0, 180 ms ease-out, once, on: each new assistant message container and each new tool card. Use `animation-fill-mode: both`. Applied by class on mount only (no re-trigger on re-render: the class is static; the animation runs when the element is first inserted).
- `StreamingCursor`: a 2px×1em bar after the last text part of the streaming assistant message, `opacity` blink 1s steps(2) while `chat.status === "streaming"`; removed at finish. `aria-hidden`.
- `PendingDots`: replaces "Thinking…" while `status === "submitted"`: text "Thinking" and three dots whose opacity pulses in sequence (600 ms loop). `role="status"`.
- Reads: while running, the tool name label gets `.shimmer` (a moving highlight over text via background-clip, 1.2 s loop). Settles to the check or cross with a 140 ms colour transition.
- `StepProgress` in the action card: four segments `build → simulate → approve → confirm`, mapped from `run.phase` (`preparing` → build and simulate active in turn if the run exposes it, else build; `asking` → approve; `confirming` → confirm). Done segments filled lime, the active one pulses (opacity 0.6↔1, 900 ms), the rest at 25 %. `aria-label="Step {k} of 4: {name}"`.
- `CheckDraw`: an SVG check whose `stroke-dashoffset` animates from its length to 0 in 240 ms ease-out, once, when a result card mounts as `confirmed`. Denied/reverted/failed use the existing static icons with a 140 ms background transition on the pill.
- Prompt send button: 140 ms scale 0.97 on `:active`. Suggestion chips: 140 ms background.
- `@media (prefers-reduced-motion: reduce)`: all of the above → `animation: none; transition: none`; the cursor and dots render static; the shimmer is plain text.

- [x] **Step 1: Failing tests.** Unit for `StepProgress` and `CheckDraw`. `chat.spec.ts`: while the scripted model streams, `[data-testid="streaming-cursor"]` is visible and it is gone after finish; a confirmed action shows `[data-testid="check-draw"]`; with `page.emulateMedia({ reducedMotion: "reduce" })` the computed `animation-name` of `.rise-in` is `none`.
- [x] **Step 2: RED.**  - [x] **Step 3: Implement.**  - [x] **Step 4: GREEN.**
- [x] **Step 5: Commit** `feat(web): animate the chat's pending and finished states, off under reduced motion`.

### Task 7: Record and hand off

- [x] Update `docs/superpowers/STATUS.md` (what Plan 12 added, what the owner still decides), `README.md` (the tokens page, the usage chip, the trimming rule in one line each), `apps/web/.env.example` if any variable was added (none expected).
- [x] Commit `docs(plans): record Plan 12`.

## Self-review
- Spec coverage: usage (T1, T3), trimming (T2), credit at the prompt (T4), wallet tokens (T5), motion (T6). Browser login already exists (passkey); no task.
- Types: `ChatMetadata.usage/contextTokens/contextWindow/trimmed` are named identically in T1, T2 and T3. `TransferAsset.trust` in T5 matches `TokenTrust | "unreviewed"`.
- No placeholders: every step names its test and its assertion.

---

## Record (2026-09-26)

Built in three parallel worktrees by three executors, then merged; each stream had an independent review (a security review for the tokens page, code reviews for motion and for usage), whose findings were fixed in their own commits, and the whole branch then went through an independent verifier. Gate at the tip: typecheck, lint, 1,067 unit tests, the production build, 44 of 44 end-to-end tests, no retries. The review leftovers were then closed in two follow-up commits and the gate run again with the same result.

**Where the code differs from the plan, and why**

- *Trimming* counts only the messages against the budget; the budget already subtracts the instructions, tools and maximum output. `contextBudget` is `min(window, 200k) - reserved`, no 8k floor. The cut lands only where one of the person's messages starts, found by binary search.
- *`contextTokens`* is the last step's measured input, with the estimate as fallback.
- *Usage on a continued turn* is added to the earlier turn's, not replaced; `stoppedForBudget` is always sent. The router reading stays on a continued reply.
- *Replies left* count from the per-send floor the server reports (`sendFloorMicrousd` on each finish, and a default-model floor on the session), because a send needs one worst-case step held, which the plan's average-only formula ignored. Below the floor the chip says "add more to chat".
- *The session route* does not import the chat module; the billing constants are read lazily through `lib/server/billing/config.ts`, and `MAX_OUTPUT_TOKENS` and `MAX_STEPS` moved to `@repo/agent/limits`.
- *Body cap* is 4 MB, under Vercel's 4.5 MB request limit so the route and not the platform answers, and an oversized chat gets 413 `CHAT_TOO_LONG`; the browser says the same for a bare 413. The message limit is 1,000.
- *Tokens page*: the mock token is TEST, not EURC (EURC is already listed); `verifyToken` also reads `balanceOf` and refuses a revert; balances use `allSettled` and an unreadable token shows "Balance unavailable" with only Remove; the withdraw confirm card labels unreviewed tokens, shows the contract address and warns when a symbol matches a reviewed one; test ids use the lowercased address; an unreviewed token never gets a gas reserve. Follow-up: tokens whose `symbol()`/`name()` return `bytes32` are read with a second decode; a provider error during the reads (internal RPC, HTTP, timeout) is reported as "could not be checked", while a bare `-32000` revert, Geth's way of saying a contract does not answer, still refuses, as does an EVM halt (invalid opcode, out of gas, a node's VM execution error); removing a token also drops its pin and hide flags.
- *Motion*: the check draws in 200 ms; the cursor is the app's own element on its own line under the text, not Streamdown's caret; the simulate segment is never active because the run does not separate building from simulating; the step bar is a `progressbar` with `aria-valuetext`; `rise-in` sits on a wrapper keyed by tool call and only for messages not present at load; the drawn check animates only for a run this view watched. Follow-up: one always-mounted `role="status"` element says "Thinking" while a reply is pending (the visible dots are `aria-hidden`), and a unit test parses `globals.css` and fails if an animated or transitioning selector is missing from the reduced-motion block. Left: Streamdown's inline caret; the cursor on its own line was accepted.
- *Sidebar*: the chat list keeps room for two rows and the column scrolls, because the added nav entry squeezed the list to nothing at 720 px.
- *End-to-end ports* move with `E2E_PORT`, so parallel checkouts do not collide.

A test now also proves the Jev reader receives the trimmed history.

**Found on the way, not in this plan's scope**: the first-run dialog has no route check; the pitch videos carry a developer badge; a given-up speculative call can be charged twice in a rare ordering (`speculation.ts:86`). All three are in `STATUS.md` for the owner.
