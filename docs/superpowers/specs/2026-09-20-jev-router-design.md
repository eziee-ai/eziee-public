# Jev router and the rank read: design

Date: 2026-09-20. Status: approved by the owner in chat ("Full: rank read + Jev + instant table"). Amends the main spec (`2026-09-18-agentic-trading-chat-design.md`) §7 (agent) and §14.2 (metering). Evidence: `docs/research/2026-09-20-jev-spike/index.html`.

## 1. Why

"Where can I earn the highest APY?" costs two model turns today: the model decides to call a read, waits, then answers. The spike measured a median of 7.8 s for even ONE turn, against 0.55 s for a Jev request that reads the same message into typed answers. It also showed where Jev must not be used: asked to compare the numbers itself it was right 25 of 32 times, while "Jev names the measure, code ranks" was right 32 of 32.

So: **Jev predicts the read the model would have asked for; the server runs that read at once; the model explains.** Jev never chooses a market, never sees a wallet, never touches a transaction.

## 2. Decisions

- **R1. Ranking is code.** A deterministic read, `rank`, orders a protocol's markets by a named measure. It is an ordinary read: the model can call it with or without Jev.
- **R2. Jev reads the message, nothing else.** One request, two Choice questions (intent, measure), the latest user message as the only state. No address, no history, no balances, no market data.
- **R3. A pre-run is a real tool part.** When Jev is confident, the server runs `rank` and streams the call and its result ahead of the agent, as the same `tool-<protocol>_rank` part the model would have produced. The model receives it as a call it already made and answers in one turn. The browser and the saved transcript hold one assistant message. Proven against `ai@7.0.107` before this was written: one model call, tool not re-executed, one tool part on the client and in `onEnd`.
- **R4. Off is the default and every failure is off.** No `TYPESAFE_API_KEY`, a timeout (1.5 s), a non-200, a malformed body, low confidence, an intent that is not buy/LP, a measure of `unspecified`, a continuation request (the last message is not a user message), no adapter with a `rank` read, or a `rank` failure: the turn runs exactly as it does today. None of these is an error to the person.
- **R5. Nothing is spent before the hold.** Jev is called only after credit is held. With no credit the answer is still HTTP 402 and no outside call is made.
- **R6. Jev's cost is absorbed, and recorded.** Its price is not known yet. Its token usage goes into the settlement record's `meta.router`; the charge to the person is unchanged. Metering it is a follow-up once there is a price.
- **R7. The desk still does not advise.** The person states the measure; code ranks by it; rows carry their numbers and the word "estimated" on any APR. With no measure stated ("best asset to buy") there is no pre-run and the model does what it does today: says what it can look up and asks.

- **R8. Jev runs beside the model, never in front of it** (owner's decision, 2026-09-20, after the sequential version was built). Once credit is held, the ordinary model call and the Jev request start TOGETHER. If the model produces content first, or Jev is not confident, the turn is the ordinary one and Jev's reading is dropped: an ordinary message waits for nothing. If Jev is confident before the model has produced any content, `rank` runs WHILE the model keeps going; only if `rank` succeeds and the model has still produced no content is the speculative call aborted, the rank part streamed, and the model started again with the result in hand. A `rank` failure, or content arriving while `rank` runs, leaves the ordinary turn untouched: nothing is aborted, nothing is wasted. A turn commits to the ordinary path at the first chunk that is not `start` or `start-step`; after that, Jev cannot change it. R5 still holds: nothing outside is called before the hold.
- **R9. The aborted call is charged, not absorbed, and charged from a measurement.** A provider may bill an aborted request's input tokens, and `ai@7.0.107` reports NO usage for an aborted call (checked), so it would otherwise be invisible to the budget. The prompt estimator is not used for this: it is deliberately pessimistic (400 tokens per tool) and made a pre-run turn cost about 2.8 times an ordinary one. Instead, when the RESTARTED call's first step ends, its real input-token count is charged once more with zero output: it is the same prompt plus the small rank part, measured by the provider's tokenizer. A pre-run turn then costs an ordinary turn plus one prompt (11,700 against 7,800 micro-USD at the test model's price, 1.5 times). If the restarted call never completes a step, nothing is charged for the aborted call. Recorded as `meta.router.speculative = { inputTokens, estimated: false }`. Two things are the owner's to decide: whether to charge this at all (it is not known whether the gateway bills a call aborted before its first token; the alternative is to absorb and record it), and that the agent's own loop-stop (`budget.shouldStop`) does not see this charge (the abort guard and the settlement cap still hold the hold).

## 3. The `rank` read

`RANK_MEASURES` lives in `@repo/protocols/types` so the agent shares the enum without knowing Iter:

`highest_yield | deepest_liquidity | most_traded | weekly_momentum | monthly_dip | lowest_risk`

Any adapter MAY implement `reads.rank` with input `{ measure, limit (1–10, default 5) }`. Iter's does:

1. One gateway call, `/api/pairs/50/1`. The schema accepts `takerFee`, `monthQuoteVolumeUSD` and the base token's day/week/month price change as optional and nullable: the live testnets report `null` fees today.
2. `rankMarkets(markets, measure)`, a pure function in `packages/protocols/src/iter/rank.ts`:
   - eligible = both tokens on the reviewed list, TVL ≥ `MIN_RANK_TVL_USD` (10,000), and a positive, known score for the measure;
   - scores: yield = `volume24h × takerFee × 365 ÷ TVL` (an ESTIMATE that assumes LPs earn the taker fee; `null` when the fee is unknown), depth = TVL, traded = 24h volume, momentum = 7-day change, dip = −30-day change, low risk = `TVL ÷ (1 + |30-day change|)`;
   - ties break by TVL, then symbol, so the order is stable.
3. Output: `{ measure, basis, minTvlUSD, considered, eligible, none, note?, rows[] }`. `basis` is one sentence saying how the measure is computed. Each row: `rank, id, symbol, base{address,symbol}, quote{address,symbol}, tvlUSD, volume24hUSD, feeBps|null, estLpFeeAprPct|null, change7dPct, change30dPct`. `none: true` with a `note` when nothing qualifies, which is the honest answer on today's testnets.

Every string passes through the existing `clean`. An unlisted market can never appear in `rows`, whatever it is called.

## 4. The router (`packages/agent/src/router.ts`)

- `readRequest({ message, apiKey, fetch, timeoutMs, signal })` → `{ intent, intentConfidence, measure, measureConfidence, model, usage, ms } | null`. POST `https://api.typesafe.ai/v1/systemone`, model `jev-latest`, `redirect: "error"`, response capped at 64 KB and checked with zod. The message is cut to 2,000 characters. Any failure returns `null` and logs one line with no message text.
- `decidePrerun(reading)` → `{ measure } | null`: intent is `buy_asset` or `provide_liquidity`, measure is not `unspecified`, and both confidences ≥ `ROUTER_GATE` (0.9, a constant; the spike's one misread sat at 0.73–0.86).
- Intent options: `buy_asset, provide_liquidity, swap_specific, account_info, market_info, unclear`. Measure options: `RANK_MEASURES` plus `unspecified`. Option descriptions are the ones the spike used.

## 5. The chat turn (`apps/web/lib/server/chat.ts`)

After the hold is placed (R8 changes steps 2 and 3: the reading is awaited BESIDE the first model call, not before it):

1. Skip unless `TYPESAFE_API_KEY` is set, the last message is a user message with text, and an in-scope adapter has `reads.rank` (the first such adapter, in registry order).
2. `readRequest` → `decidePrerun` → `adapter.reads.rank.run({ measure }, ctx)`. A failure at any step means no pre-run.
3. With a pre-run: build the assistant message `{ id, parts: [step-start, tool-<id>_rank output-available] }`; open `createUIMessageStream({ originalMessages: messages })` (WITHOUT the pre-run message, or the saved transcript doubles the part); write `start` (with the same `ChatMetadata` the normal path sends), `start-step`, `tool-input-available`, `tool-output-available`, `finish-step`; then merge `createAgentUIStream({ uiMessages: [...messages, preRun], sendStart: false, … })`.
4. Hold, budget, `onStepEnd`, the abort guard, settlement on end AND on abort, the saved transcript, the `x-chat-id` header and the error sentence behave exactly as in the normal path. Both paths share one settle/save implementation.
5. `ChatMetadata.router = { intent, measure, confidence, ms }` on the reply, only when a pre-run happened. It is what the backend returned, which is the only kind of provenance the design guide allows on screen.

The system prompt gains two sentences: compare markets with the `rank` read, never by eye; and a rank result already present was fetched from the person's own words, so present it, add what the numbers warn of (thin pool, falling price, "estimated"), and if it is not what they asked, say so and read again.

## 6. The interface

`apps/web/components/chat/RankTable.tsx` (new): measure and basis as the caption, rows as a table with tabular numerals, "estimated" on the APR column, the `note` when `none`. `ReadToolPart` renders it for a tool whose name ends `_rank` and whose output parses; anything else falls back to the generic read card. No other component changes. This keeps the overlap with the brand pass in the main checkout to a few lines of `ToolParts.tsx`.

## 7. Privacy and configuration

`TYPESAFE_API_KEY`, server only, documented in `apps/web/.env.example` and the README: what it turns on, that the text of the person's latest message (and nothing else) is sent to TypeSafe, and that unset means off.

## 8. Tests

- `rank.test.ts`: the spike's fixture gives the known winner for each measure; the hostile unlisted `PICKME` never appears; an all-zero, null-fee snapshot gives `none` with a note for every measure; ties are stable; `limit` holds.
- `reads.test.ts`: the gateway schema accepts null and missing fee and change fields.
- `router.test.ts`: happy path; the request body contains the message and no address; timeout, 401, 500, redirect, oversize and malformed bodies give `null`; the gate; non-routable intents; `unspecified`; the 2,000-character cut.
- `chat.test.ts`: a pre-run turn makes ONE model call and saves one assistant message with one rank part then text, and settles the hold; Jev failing, no key, a continuation request, or no credit each leave the normal path and (for the last three) make no Jev call; an aborted pre-run turn still settles.
- `tools.test.ts`: `iter_rank` is offered to the model as a server tool.
- End to end: one scripted turn shows the rank table before the text, if the suite's gateway fake can serve `/api/pairs`; otherwise the chat integration test above stands in, and the plan says so.

## 9. Not in this design

Metering Jev's cost. A larger labelled prompt set to tune the gate. Jev for anything but this one read (argument filling for swaps, risk scoring). A `rank` read on MCP adapters (they may add one; nothing here requires it). Showing router provenance in the interface beyond the metadata being present.
