# Agentic Trading Chat — Design (Phase 1: Web App)

- **Date:** 2026-09-18
- **Status:** Approved in brainstorming; awaiting written-spec review
- **Scope of this spec:** Phase 1 only (web app). Phases 2–4 are listed for context and get their own specs.

## 1. Goal

A ChatGPT/T3-Chat-style web app where a user talks to an AI agent that can **trade, provide liquidity, and launch coins** onchain, using a **passkey wallet** (ported from the mera wallet in `iter-monorepo`) for signing, with **deposit and withdraw** screens modelled on Iter's. The product has its own name and domain. It is **protocol-agnostic**: Iter is the first protocol adapter; others are added later without touching the chat or wallet layers.

### Non-goals (Phase 1)

- Electron desktop app (Phase 2).
- MetaMask Agent Wallet `mm` plugin and desktop signer (Phase 3).
- Marketing landing page (Phase 4, built by the owner with motion + Astra).
- Letting the LLM hold a key, write calldata, choose arbitrary contract addresses, or bypass the permission policy.
- Sharing a wallet address with iter.cx (this app has its own rpId and therefore its own addresses).
- CCTP bridging (dropped; replaced by Aurora Intents, see §8).
- Onchain-enforced spending limits. The wallet is an EOA; limits are enforced by the isolated wallet frame (§5), not by a smart account.

## 2. Decisions log

| # | Decision | Reason |
|---|---|---|
| D1 | Chat UI is built on **Vercel AI Elements + AI SDK** (Apache-2.0), styled like T3 Chat/ChatGPT. | T3 Chat is closed source (no public repo; the Cloneathon exists because of that). AI Elements gives owned, composable primitives with nothing to strip out. |
| D2 | Execution uses a **Claude-Code-style permission model**: Allow once / Always allow… / Deny, with user-scoped rules. | Owner's request. |
| D3 | "Always allow" is **hands-free** within an unlocked session. The passkey prompt happens once on connect; the session lasts 24 h absolute. | Owner's request; matches how mera already works (PRF-derived EOA key, encrypted session in an isolated frame). |
| D4 | **Chat history** lives in a server DB keyed by wallet address. **Permission rules** are authoritative in the wallet frame's own storage, per device. | A rule the frame cannot verify is not a guardrail; server-held rules would let a compromised backend grant itself "always allow". |
| D5 | Separate brand and domain; **own wallet** (own rpId, own frame origin, own PRF salt). Passkey wallet is the default signer. | Owner's request. Owning the frame lets rules be frame-enforced from v1. |
| D6 | Protocols plug in through a **`ProtocolAdapter`** interface. Iter (RISE Testnet + Arc Testnet) is the first adapter. | Owner's request: "support iter.cx first, then add next protocol". |
| D7 | Cross-chain funding uses **Aurora Intents**, fully implemented but **shown only for destination chains Aurora supports**. | Aurora Intents supports 35 mainnets and no testnets; RISE/Arc testnets are not reachable. The route lights up when a mainnet adapter lands. |
| D8 | Default model **`moonshotai/kimi-k3`** via Vercel AI Gateway; picker offers others. | Owner's request. |
| D9 | MetaMask Agent Wallet is a local CLI, unreachable from a browser. Phase 1 only reserves a `Signer` seam for it. | Verified from MetaMask docs and the plugin examples repo (MIT). |
| D10 | AI usage is paid from a **prepaid, USD-priced credit ledger** debited by each request's real cost plus margin. Top-up rails: **USDC onchain, card (Stripe), and the app's own utility token at a discount**. No free grant and no promo codes. | Owner's request (amended 2026-09-18): AI cost per message is unpredictable, so a flat price would leave the operator carrying the risk. Pricing in USD keeps metering independent of a floating token price; the token needs a price only at top-up time. |
| D11 | Other protocols join through **MCP plus a reviewed manifest**: the protocol hosts an MCP server (reads and transaction building), and a static manifest merged into this repo is the only thing the wallet frame decodes against. Iter stays a first-party in-repo adapter and publishes the same manifest format. | Owner's request (amended 2026-09-20): "modularize it so that other projects can connect". An external server cannot be a trust anchor for signing (D4), so the manifest carries the trust and MCP carries the convenience. |
| D12 | **Model and protocol are chosen in the prompt input**, as two pills beside the send button. The protocol pill also sets the network and scopes which adapters' tools the model receives; "Auto" offers every enabled protocol on the active network. | Owner's request (amended 2026-09-20). Fewer tools per request also improves tool-calling reliability. |
| D13 | **Independent desk brand**, with GGEZ-inspired acid lime/ink colors; Jev is the intended structured-decision engine and Iter is one integration. | Owner's direction (2026-09-20). Root `DESIGN.md` owns current visual guidance; the existing model runtime stays documented in §7.3 until Jev is integrated. |

## 3. Phasing

1. **Web app v1** — this spec.
2. **Electron desktop shell.** Known constraint: the wallet address is bound to the WebAuthn rpId (hostname) and Electron has weak platform-passkey support, so the desktop app will load the hosted origin or hand authentication to the system browser. Phase 1 keeps all wallet origins configurable to allow this.
3. **MetaMask Agent Wallet**: an `mm` plugin exposing the protocol adapters as commands, plus an optional desktop signer that implements the `Signer` seam.
4. **Landing page** (owner).

## 4. Repository layout

Turborepo, pnpm 10, Node 22, TypeScript strict, Next.js 16 (App Router), React 19, Tailwind CSS v4, shadcn/ui (new-york). Workspace scope `@repo/*`. The product name is one constant, `BRAND` in `packages/ui/src/brand.ts` (initial value `"AI Finance"`), so renaming never touches package names.

```
apps/web                 Next.js app: chat, deposit, withdraw, settings/permissions, /wallet-frame routes, API routes
packages/wallet          ported mera wallet + new rule engine (§5)
packages/protocols       ProtocolAdapter + FundingRoute interfaces, adapters/iter, funding/aurora-intents (§6, §8)
packages/agent           AI SDK tool definitions generated from adapters, intent schemas, system prompt (§7)
packages/db              Drizzle + Postgres (Neon): users, sessions, chats, messages (§9)
packages/ui              shared shadcn + AI Elements components, design tokens, fonts, BRAND
packages/typescript-config
packages/eslint-config
```

Dependency direction: `apps/web → agent → protocols`; `apps/web → wallet → protocols` (decoders only); `protocols` depends on nothing in the repo. `wallet` never imports `agent` or `db`.

## 5. `packages/wallet`

### 5.1 What mera is

`@category-labs/mera@0.2.0` (MIT OR Apache-2.0) turns a WebAuthn passkey's PRF output (32 bytes) directly into a secp256k1 private key for a plain EOA. No ERC-4337, bundler, or paymaster. The version stays pinned: a defect in key derivation loses funds silently.

### 5.2 Ported unchanged (with their tests)

From `iter-monorepo/apps/web/lib/wallet/`: `mera.ts`, `webauthnClient.ts` (Chrome PRF fixes, L3 hints, `prfKnownUnavailable` preflight), `meraSession.ts` (AES-GCM under a non-extractable IndexedDB key, 24 h absolute TTL, wipe on any failure), `meraConnector.ts` (wagmi connector, reconnect never prompts), `index.ts` hooks (`useWalletAccount`, `useWalletConnect`, `describeConnectError`), `walletFailure.ts`, `connectGate.ts`, and `frame/{client,host,signer,protocol,origins}.ts`.

Changes limited to constants:

- PRF salt: `"wlt1.mera.v1.secp256k1.account\0\0"` (32 bytes, brand-neutral so a rename never forces a change). **Fixed forever once shipped.**
- Storage keys and IndexedDB name: `wlt.mera-credential`, `wlt.mera-session`, DB `wlt.mera`.
- `postMessage` channel: `wlt.wallet-frame`.
- `rp.name` reads `BRAND`; `rpId` stays `window.location.hostname`.
- `chainById()` reads chains from the registered adapters instead of `@/lib/customChains`.

Not ported: `sendBatch.ts`, `batchTransfer.ts`, `withdrawSplit.ts`, `feeWallet.ts` (fee-split via EIP-7702 `BatchExecutor` is out of v1; `mera_sendBatch` is removed from `SIGNING_METHODS` and from the signer).

### 5.3 Rewritten: `frame/policy.ts` — the rule engine

Evaluation order for every signing request, inside the frame:

1. **Always confirm, no rule can cover it:** native transfer; ERC-20 `transfer`/`transferFrom`; `approve` whose spender is not an adapter-registered router, or whose amount exceeds the amount of the action it accompanies; all typed data; non-text messages; unknown methods; unknown chains; any call to a contract not registered by an adapter.
2. **Adapter call:** the target is an adapter-registered contract. The frame runs that adapter's pure `decode(chainId, tx)` to obtain `{protocol, action, spend: {token, amount}[]}`. If decoding fails → confirm.
3. **Rule match:** a decoded action is signed silently only if an unexpired rule matches protocol, action, chainId, token (`address` or `"any"`), `amount ≤ maxPerTx`, and `spentToday + amount ≤ maxPerDay`. Otherwise → confirm card.
4. Plain-text `personal_sign` whose text matches the sign-in template (§9.1) → silent. Any other text → confirm.

Rule shape:

```ts
type Rule = {
  id: string;
  protocol: string;            // "iter"
  action: string;              // "swap" | "placeOrder" | "addLiquidity" | ...
  chainId: number;
  token: Address | "any";
  maxPerTx: bigint;            // base units of `token`; must be 0 when token is "any"
  maxPerDay: bigint;           // base units of `token`; must be 0 when token is "any"
  expiresAt: number;           // ms epoch; default = session expiry
  persistent: boolean;         // false = dies with endMeraSession()
};
```

Rules for `token: "any"` are restricted to actions that spend nothing from the wallet (e.g. `cancelOrder`, `removeLiquidity`); any spending rule names one token, so caps are always in that token's own base units. Decimals are read onchain by the frame and never assumed (Arc: native USDC is 18 decimals, the ERC-20 is 6).

Storage: rules and per-day counters live in frame-origin IndexedDB (`wlt.mera` / store `rules`). The app origin cannot write them. `endMeraSession()` deletes non-persistent rules.

INVARIANT: no request is signed without either (a) a matching unexpired rule evaluated on frame-decoded calldata, or (b) a real click inside the cross-origin confirm frame.
INVARIANT: the confirm card's text is derived only from frame-decoded calldata and onchain reads, never from strings supplied by the app.

### 5.4 Frame routes (served by `apps/web`, outside the app layout, nonce CSP, `force-dynamic`)

- `/wallet-frame` — hidden RPC host.
- `/wallet-frame/confirm` — the card: decoded restatement, simulation outcome, buttons **Deny / Allow once / Always allow…**. "Always allow…" expands a scope editor (token, per-tx cap, per-day cap, expiry, persistent) prefilled from the current action.
- `/wallet-frame/rules` — list and revoke rules; embedded by Settings → Permissions.
- `/wallet-frame/blocked` — shown when the host check fails.

Env: `NEXT_PUBLIC_WALLET_ORIGIN` (read by app), `NEXT_PUBLIC_WALLET_APP_ORIGIN` (comma list, read by frame). Both documented in `.env.example`. Unset ⇒ same-origin (localhost dev). A production build with them unset logs an error (ported behaviour).

### 5.5 Signer seam

```ts
interface Signer {
  id: string;                                   // "mera"
  connect(): Promise<Address>;
  request(chainId: number, rpc: WalletRpc): Promise<Hex>;
  disconnect(): Promise<void>;
}
```

The mera connector is the only implementation in Phase 1.

## 6. `packages/protocols`

```ts
interface ProtocolAdapter {
  id: string;
  chains: Chain[];
  contracts(chainId: number): Record<string, Address>;
  tokens(chainId: number): Token[];             // {address, symbol, decimals, trust}
  actions: Record<string, {
    intent: ZodSchema;
    build(intent, ctx): Promise<TxRequest[]>;   // deterministic; includes exact-amount approve when needed
    simulate(txs, ctx): Promise<SimResult>;     // eth_call / estimateGas against the user's address
  }>;
  reads: Record<string, { input: ZodSchema; run(input, ctx): Promise<unknown> }>;
  decode(chainId: number, tx: TxRequest): DecodedAction | null;  // pure, no network; used by the frame
}
```

### 6.1 Iter adapter (v1)

- **Chains:** RISE Testnet (11155931), Arc Testnet (5042002). Chain definitions ported from `apps/web/lib/customChains.ts`.
- **Actions:** `swap` (BandSwapRouter), `placeOrder` / `cancelOrder` (MatchingEngine), `addLiquidity` / `removeLiquidity` (BandPositionManager), `launchCoin` (AssetGenerator).
- **Reads:** `quote`, `pools`, `orderbook`, `positions`, `tokenInfo`, `balances`.
- **ABIs and addresses:** vendored from `iter-monorepo/packages/abis` and `packages/deployments/deployments.json`, each address carrying a source comment. `scripts/verify-addresses.ts` runs `cast code` for every address on its chain and exits non-zero if any returns `0x`; it runs as part of `turbo test` for `packages/protocols`. No address is typed by hand.
- **Approvals:** `build` emits `approve(router, exactAmount)` only, never `type(uint256).max`.
- **Slippage:** every spending intent carries `maxSlippageBps`; `build` re-quotes and throws `QuoteMoved` if the fresh quote breaches it.
- **Licensing note:** Iter's contracts are BUSL-1.1 (Digital Native Standard Ltd.). Only ABIs and addresses are vendored; no contract source is copied.

## 7. `packages/agent` and the chat

### 7.1 Tools

Generated from adapters: each `reads.*` becomes a **server-executed** tool; each `actions.*` becomes a **client-side** tool (no server `execute`). Plus app tools: `openDeposit`, `openWithdraw` (prefills the withdraw preview; still confirm-tier), `getWalletStatus`.

### 7.2 Action flow

1. Model calls an action tool with a typed intent. Tokens are symbols/addresses resolved against the adapter token list; unknown tokens are rejected before building.
2. Client runs `adapter.build` → `adapter.simulate`. A revert returns a tool error to the model.
3. Client sends each tx to the wallet frame. The frame decodes and either signs silently (rule match) or the chat renders `TxProposalCard`, which embeds `/wallet-frame/confirm`.
4. Outcome (`submitted` hash → receipt, `denied`, `failed`) is returned with `addToolResult`. The system prompt forbids retrying a denied action without a new user request.

### 7.3 Model access

Vercel AI Gateway, plain `"provider/model"` strings. Default `moonshotai/kimi-k3`. The picker shows the intersection of a config allowlist (`packages/agent/src/models.ts`, initially `moonshotai/kimi-k3`, `moonshotai/kimi-k3-fast`, `anthropic/claude-sonnet-5`) and the gateway's live `/v1/models`, so a model removed upstream disappears instead of erroring. Env: `AI_GATEWAY_API_KEY`.

### 7.4 Chat UX

T3/ChatGPT layout: collapsible sidebar (history, search, new chat), centered thread, prompt input with suggestion chips. The prompt input carries two pills (D12): a **protocol pill** (network segmented control; Auto or one protocol; a "Verified over MCP" section; "Add a custom MCP server", read-only) and a **model pill** (the §7.3 allowlist). The selection is stored per chat and sent with each message; the server builds the tool list from the selected adapters only. On mobile both open as bottom sheets. AI Elements for message, reasoning, and tool-state rendering. Custom cards: `QuoteCard`, `TxProposalCard`, `TxResultCard` (confirming / confirmed / reverted, hash in DM Mono, explorer link), `PositionCard`, `LaunchPreviewCard`. Model output renders as sanitized markdown, no raw HTML. Visual language follows this repository's root `DESIGN.md` (2026-09-20 update): an independent acid-lime/ink AI desk inspired by GGEZ, shared `--m-*` tokens, Satoshi + DM Mono, protocol-neutral identity, P&L always shown with sign and number, WCAG 2.2 AA, 44 px approval targets, 360 px → ≥1280 px. Iter is one protocol integration, not the parent brand. Jev is the intended structured-decision engine; this design update does not replace the current chat-model runtime.

## 8. Deposit and withdraw

Ported from `components/Transfer/`: `TransferShell` (pill toggle, network guard), `DepositPanel`, `WithdrawPanel`, `TransferResult`, `RecipientPicker`, plus `lib/wallet/{depositAssets,depositMax,externalFunding,withdraw,gasDeposit,gasStatus}.ts`.

- **Deposit:** asset list → chosen summary → EIP-681 QR (`ethereum:<address>@<chainId>`, black on white) + full untruncated address with copy + "this network only" warning; "Deposit from a browser wallet" via EIP-6963 (raw EIP-1193, outside wagmi; `multiInjectedProviderDiscovery: false` is kept); testnet faucet link.
- **Withdraw:** asset → hero amount + Max → recipient (validation: full 42 chars, no self-send, not over balance) → **Preview** → irreversibility card → confirm inside the wallet frame → `TransferResult`.
- **Dropped:** CCTP, `ClaimDeposit`, fee split, server-side transfer history. History shows locally recorded receipts.

### 8.1 Aurora Intents (`FundingRoute`)

```ts
interface FundingRoute {
  id: string;                                    // "aurora-intents"
  supportsDestination(chainId: number): boolean;
  sources(): Promise<SourceAsset[]>;
  quote(req): Promise<FundingQuote>;             // depositAddress, depositMemo?, amountOut, minAmountOut, timeEstimate
  submit(req): Promise<void>;
  status(id): Promise<FundingStatus>;            // PENDING_DEPOSIT | PROCESSING | SUCCESS | REFUNDED | FAILED | ...
}
```

- API: `https://intents-api.aurora.dev` — `POST /api/quote/{apiKey}`, `POST /api/deposit/submit/{apiKey}`, `GET /api/status/{apiKey}`. The key is in the URL path, so all calls go through server routes `/api/funding/{sources,quote,submit,status}`; env `AURORA_INTENTS_API_KEY` is server-only.
- UI: "From another chain" on Deposit (source chain/token → quote → deposit address + QR → live status); "To another chain" on Withdraw (always confirm-tier). `refundTo` is always set.
- **Gating:** both sections render only when `supportsDestination(chainId)` is true. For RISE/Arc testnets it is false, so they are hidden in v1.
- `appFees` defaults to empty (no integrator fee) and is configurable.

## 9. `packages/db` and auth

Postgres (Neon) + Drizzle. Tables: `users(address pk, created_at)`, `sessions(id, address, expires_at)`, `chats(id, address, title, model, created_at, updated_at)`, `messages(id, chat_id, role, parts jsonb, created_at)`. All queries are scoped by the session's address. Env: `DATABASE_URL`, `SESSION_SECRET`.

### 9.1 Sign-in

After connect, the app requests a nonce (`/api/auth/nonce`), and asks the frame to `personal_sign` the fixed template:

```
<BRAND> sign-in
Address: <address>
Nonce: <nonce>
Issued: <iso8601>
```

The frame signs silently only if the text matches this template exactly (§5.3 step 4). The server verifies the signature and nonce (single use, 5 min TTL) and sets an httpOnly, SameSite=Lax session cookie (24 h, matching the wallet session).

## 10. Error handling

- Wallet: ported human copy for `PRF_UNAVAILABLE`, `PASSKEY_OPERATION_FAILED`, `CRYPTO_UNAVAILABLE`; `LOCKED`/expired session → re-unlock prompt, then the pending action resumes.
- Simulation revert, `QuoteMoved`, unknown token → tool error to the model with a machine-readable code; the model explains or adjusts.
- Frame **Deny** → tool result `denied`; no automatic retry.
- Tx reverted onchain → `TxResultCard` reverted state with Retry (keeps figures).
- Aurora Intents `REFUNDED`/`FAILED`/`INCOMPLETE_DEPOSIT` → status tracker shows state and refund address.
- Gateway/model failure → inline retry on the message; chat state is not lost.

## 11. Testing

- **Unit (Vitest):** ported wallet tests; table-driven rule-engine tests (adversarial calldata, wrong chain, at-cap, over-cap, daily rollover, expired rule, `approve` to unknown spender, template-mismatch sign-in text); adapter `build`→`decode` round-trips for every action; Aurora client against recorded fixtures.
- **Fork (anvil, pinned block):** each Iter action on RISE and Arc testnets with tokens of 6 and 18 decimals.
- **E2E (Playwright + virtual WebAuthn authenticator with PRF):** connect, deposit address/QR, withdraw preview → confirm, scripted chat turn with a mocked model covering Allow once, Always allow, Deny, and a silent rule-matched execution.
- **Live, read-only:** Aurora `dry: true` quote on mainnet assets.
- **Gate:** `turbo typecheck lint test` green; no `test.skip`/`.only`; address verification script passes.

## 12. Build order (milestones for the implementation plan)

1. Monorepo scaffold, shared configs, `packages/ui` tokens/fonts.
2. `packages/wallet` port + frame routes + connect UI; ported tests green.
3. `packages/protocols` interface + Iter adapter reads + address verification.
4. Deposit and withdraw screens.
5. Rule engine + confirm/rules frame pages.
6. Iter adapter actions + decoders + fork tests.
7. `packages/db`, sign-in, chat persistence.
8. `packages/agent` + chat UI + tool cards.
9. Aurora Intents funding route (gated).
10. E2E suite, accessibility pass, `.env.example`, README.

Billing (§14) slots into this order: the ledger, metering, the 402 response and the balance UI are built with milestones 7–8; the three top-up rails follow milestone 10 in the order USDC, card, token.

## 13. Risks

- **Key-handling port.** Mitigation: copy rather than rewrite, keep tests, keep the mera pin, change constants only.
- **Rule engine is new security-critical code.** Mitigation: pure functions, exhaustive table tests, default-deny, independent security review before any mainnet adapter.
- **EOA limits are not onchain guarantees.** A compromised wallet origin defeats them. Mitigation: separate wallet origin, strict CSP, no third-party scripts on frame routes.
- **Testnet-only protocols.** RISE/Arc testnet RPC instability affects fork tests; pin blocks and cache.
- **Kimi tool-calling quality** on multi-step intents is unmeasured; the mocked-model E2E isolates the app from it, and the picker allows fallback.
- **Real payments need a mainnet.** RISE and Arc are testnets, so the USDC and token rails carry no value there. The card rail is the only one that can take real money before a mainnet payment chain is configured.
- **Selling a utility token that buys a service** carries regulatory exposure. It needs legal review before launch; building the rail does not depend on that review, and the rail ships dormant.
- **Token-rail price manipulation.** A thin market lets a payer inflate the token's price before topping up. Mitigation: value by simulated swap of the actual amount, apply a haircut, and cap per top-up and per day.
- **Card chargebacks** after credits are spent leave a negative balance. Mitigation: negative entries block the account; pack sizes are small.

## 14. Billing (amended 2026-09-18)

### 14.1 Ledger (`packages/db`)

- `credit_accounts(address pk, balance_microusd bigint not null default 0, held_microusd bigint not null default 0, blocked boolean not null default false)`.
- `credit_ledger(id, address, delta_microusd bigint, kind, ref text unique, test boolean not null default false, meta jsonb, created_at)`, append-only. `kind ∈ topup_usdc | topup_card | topup_token | usage | refund | adjustment`.
- All amounts are integer micro-USD (1 USD = 1_000_000). No floats anywhere in billing. The UI shows dollars of credit.
- `ref` makes every credit idempotent: `<chainId>:<txHash>:<logIndex>` for onchain rails, the Stripe event id for card, the request id for usage. A replayed webhook or re-submitted hash cannot credit twice.
- Balance changes and their ledger row are written in one transaction.

INVARIANT: `credit_accounts.balance_microusd` equals the sum of that address's `credit_ledger.delta_microusd`.
INVARIANT: `held_microusd ≤ balance_microusd`, and spendable credit is `balance − held`.

New accounts start at zero. There is no free grant and no promo-code mechanism. `adjustment` exists for operator corrections only.

### 14.2 Metering

1. **Hold.** Before calling the model, the server computes a hold from the selected model's gateway price and the request's output-token cap, and adds it to `held_microusd`. If spendable credit is below the hold, the API answers **HTTP 402** with a body listing the enabled top-up rails, and the chat renders a top-up card. No model call is made.
2. **Settle.** When the stream ends (or aborts), the server sums input, output and cached-token usage across every agent step of the request, prices it from the gateway's per-model rates, multiplies by `(10_000 + BILLING_MARGIN_BPS) / 10_000` rounding up, writes one `usage` row, and releases the hold.
3. **Budget.** The hold covers two worst-case model calls, or the whole spendable balance when that still covers one. Before each further step of a tool loop the server adds up what the steps so far cost and the WORST case of the next one (the last prompt, plus what the model wrote, plus what its tools returned, plus the output cap), and ends the loop if that would pass the hold. Checking after a step is too late: that step is already paid for at the gateway. A first prompt that tokenizes far above its estimate is the one case this cannot foresee; the stream is then stopped after that step, the account is charged at most the hold, and the difference is logged as the operator's loss. (Amended 2026-09-20 after review: the original guard fired only after the hold was passed.)

Env: `BILLING_MARGIN_BPS` (default `3000`), `BILLING_MIN_HOLD_MICROUSD` (default `10_000`). Model prices come from the gateway's model listing and are cached for 10 minutes; if a model has no known price the request is refused rather than served unmetered.

Each assistant message shows its cost; the sidebar shows spendable credit.

### 14.3 Top-up rails

Every rail ends in the same place: one positive `credit_ledger` row. A rail is enabled only when its configuration is present.

**USDC.** The user sends USDC from their passkey wallet to `BILLING_TREASURY_ADDRESS` on a configured payment chain. This is an ERC-20 `transfer`, so it is always confirm-tier in the wallet frame (§5.3 step 1). The client submits the tx hash; the server credits only after checking: receipt status success; a `Transfer` log emitted by the chain's canonical USDC contract; `to` is the treasury; `from` is the signed-in account's address; at least `BILLING_CONFIRMATIONS` blocks deep. Credit = USDC amount scaled from the token's onchain decimals to micro-USD. The USDC contract address per payment chain is configured, never hardcoded, and verified with `cast code` and `symbol()`/`decimals()` before use. On a testnet the row is written with `test = true` and the UI labels the credit as test credit.

**Card.** Stripe Checkout with fixed packs of $5, $10, $25 and $50; the session's metadata carries the account address. A signature-verified `checkout.session.completed` webhook writes the credit. `charge.refunded` and `charge.dispute.created` write a negative `refund` row; an account whose balance goes negative is set `blocked` until settled. Env: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`.

**Utility token.** Same flow as USDC with the token at `BILLING_TOKEN_ADDRESS`. Its USD value is the output of a simulated swap (`eth_call`) of the exact received amount into USDC on the token's own market at the receipt's block, reduced by `BILLING_TOKEN_HAIRCUT_BPS` (default `500`) and then increased by `BILLING_TOKEN_BONUS_BPS` (default `1500`). Caps: `BILLING_TOKEN_MAX_PER_TOPUP_MICROUSD` and `BILLING_TOKEN_MAX_PER_DAY_MICROUSD` per account. Unset `BILLING_TOKEN_ADDRESS` disables the rail, so it ships dormant until the token exists on a mainnet.

### 14.4 Safety

- The treasury is an address the operator controls (a multisig is recommended). The server only reads the chain; it never holds the treasury key.
- Webhooks are verified by signature; onchain credits are verified from receipts the server fetches itself, never from client-supplied amounts.
- Top-up and chat endpoints are rate-limited per address and per IP.

### 14.5 Testing

- Unit: micro-USD rounding (always rounds cost up, credit down); ledger idempotency on duplicate `ref`; hold/settle/overrun arithmetic; 402 when spendable < hold; blocked-account refusal; token valuation with haircut, bonus and caps.
- Integration: USDC and token verification against anvil with tokens of 6 and 18 decimals, including wrong token, wrong recipient, wrong sender, reverted tx, and too few confirmations; Stripe webhook with valid signature, invalid signature, and a replayed event.
- Property: for any sequence of ledger operations, the two invariants in §14.1 hold.

## 15. Third-party protocols over MCP (amended 2026-09-20)

Full guideline for protocol teams: `docs/protocol-integration/mcp-guideline.md`. Summary of what it commits this codebase to:

- **One seam.** `ProtocolAdapter` (§6) stays the only interface the chat, agent and wallet layers know. `McpProtocolAdapter` implements it from `(manifest, MCP client)`: `reads.*` → `<id>.read.*` tools, `actions.*.build` → `<id>.build.*` tools, `simulate` runs locally (`eth_call`/`estimateGas`), and `decode` is derived from the manifest alone.
- **Manifest is the trust anchor.** `packages/protocols/registry/<id>/manifest.json` lists contracts, tokens, actions and a declarative calldata decoder per action. Manifests are bundled into the wallet frame at build time and never fetched at runtime. §5.3's rule engine is unchanged: a transaction to a contract outside a bundled manifest is confirm-tier and shown as unknown.
- **Trust tiers.** First-party (in-repo adapter) and Verified (manifest merged after review, conformance green) may be covered by "Always allow" rules. Custom (a user-pasted MCP URL) is read-only and never produces transactions.
- **Tool output is untrusted data.** Schema-validated, length-capped, rendered as plain text, never treated as instructions. `quote` from a server feeds the chat's `QuoteCard` only; the confirm card keeps its §5.3 invariant.
- **ABIs are never downloaded.** A server returns finished calldata and read results; the manifest carries only the function signatures of its action calls, which is all decoding needs. Conformance makes each signature a verified claim: match against the contract's verified source (Sourcify, then Blockscout/Etherscan-family), a build → decode round trip, and a simulated asset-movement check against the decoded spend (guideline §4a).
- **Conformance.** `pnpm protocols:conform <manifest>` verifies addresses (`cast code`, `symbol()`, `decimals()`, proxy slots), `tools/list` against the manifest, and a build → decode round trip per action on a pinned fork.

Build order: the manifest schema, the declarative decoder and the Iter manifest land with milestones 3 and 6; `McpProtocolAdapter`, the conformance command and the Custom tier follow milestone 8. INVARIANT: no code path lets an MCP response add a contract, token or decoder at runtime.
