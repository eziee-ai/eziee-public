# Plan 2 — Protocol Package, Manifest Format and Iter Reads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `@repo/protocols` package that defines the one protocol seam, validates and decodes against reviewed manifests, and ships Iter as the first adapter with verified addresses and working onchain reads.

**Architecture:** `ProtocolAdapter` is the only interface other layers know. A **manifest** (static JSON, validated by a zod schema) lists a protocol's contracts, tokens and actions, and carries a declarative calldata decoder, so the wallet frame can later decode any protocol from data alone (spec §15, D11). Iter is a first-party adapter: its reads are TypeScript over viem, its addresses and ABIs are vendored by script from `iter-monorepo`, and it publishes the same manifest format every other protocol will use.

**Tech Stack:** TypeScript ^5.8 strict, viem ^2.23.5, zod **3.25.76 exact** (root `pnpm.overrides` pins it; a second version splits wagmi), Vitest ^2.1.9, Foundry `cast` for address verification.

**Spec:** `docs/superpowers/specs/2026-09-18-agentic-trading-chat-design.md` §6, §6.1 (reads only), §15, build-order milestone 3. Guideline for third parties: `docs/protocol-integration/mcp-guideline.md` (§4 defines the manifest this plan implements).

**Sequence change.** Plan 1 listed "2 — protocols + Iter reads + deposit/withdraw". The transfer port spans 30+ files and consumes this package's token list, so it becomes Plan 3; later plans shift by one. Research for it is saved in `.omc/research/2026-09-20-transfer-port-map.md`.

## Global Constraints

- Branch: `feat/plan-2-protocols`, created from `feat/plan-1-scaffold-wallet`.
- Workspace scope `@repo/*`; internal packages export TypeScript source (`"exports"` → `./src/*.ts`).
- `packages/protocols` must not import from `@repo/wallet`, `@repo/agent`, `@repo/db` or `apps/*`. `packages/wallet` must not import from `@repo/protocols` (Plan 1 constraint, unchanged).
- **No address is typed by hand.** Addresses enter the repo only through `scripts/vendor-iter.ts`, which copies them from `iter-monorepo/packages/deployments/deployments.json`. Test fixtures use the obviously fake `0x00000000000000000000000000000000000000A1`-style addresses defined in `src/testing/fixture.ts`.
- Iter's contracts are BUSL-1.1. Vendor ABIs and addresses only; never copy contract source.
- Decimals are never assumed. Arc's native USDC is 18 decimals and its ERC-20 view at the same funds is 6.
- `decode` paths are pure: no network, no clock, no randomness.
- No `test.skip`, `test.only`, TODO placeholders. Terminology: onchain, offchain.
- Every commit message ends with: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`

---

### Task 1: Package scaffold, core types and the manifest schema

**Files:**
- Create: `packages/protocols/package.json`, `tsconfig.json`, `eslint.config.mjs`, `vitest.config.ts`
- Create: `packages/protocols/src/types.ts`, `src/errors.ts`, `src/manifest/schema.ts`, `src/manifest/schema.test.ts`, `src/testing/fixture.ts`

**Interfaces:**
- Produces: `ProtocolAdapter`, `Token`, `TxRequest`, `DecodedAction`, `DecodedApproval`, `AdapterContext`, `SimResult` (`src/types.ts`); `ProtocolError`, `ProtocolErrorCode` (`src/errors.ts`); `manifestSchema`, `parseManifest(input: unknown): Manifest`, types `Manifest`, `ManifestCall`, `ManifestRef` (`src/manifest/schema.ts`); `FIXTURE_MANIFEST`, `ADDR` (`src/testing/fixture.ts`).

- [ ] **Step 1: Package files** — mirror `packages/ui/package.json`: name `@repo/protocols`, exports `"."`, `"./types"`, `"./errors"`, `"./manifest"`, `"./registry"`, `"./iter"`; dependencies `viem ^2.23.5`, `zod 3.25.76`; same devDependencies as `@repo/ui` plus `@types/node ^22.0.0`, `tsx ^4.19.0`. `tsconfig.json`: `{ "extends": "@repo/typescript-config/base.json", "include": ["src", "scripts"] }`. `vitest.config.ts`: `include: ["src/**/*.test.ts"]`.
- [ ] **Step 2: Write `src/types.ts` and `src/errors.ts`** (code in the task's implementation commit; shapes fixed by the Interfaces block of Tasks 2–6).
- [ ] **Step 3: Write the failing schema tests** — `src/manifest/schema.test.ts`, table-driven: accepts the fixture; rejects a non-checksummed address, an action call naming an unknown contract key, a `{ "arg": "x" }` ref that is not an input of the call's ABI, an unparseable ABI string, `spends: false` with a non-empty `spend`, `spends: true` with no `spend` anywhere, a token or contract listed under a chain id absent from `chains`, a duplicate token address within a chain, an `id` with uppercase, and more than 4 calls in one action.
- [ ] **Step 4: Run** — `pnpm install && pnpm --filter @repo/protocols test`. Expected: FAIL, cannot resolve `./schema`.
- [ ] **Step 5: Implement `src/manifest/schema.ts`** with zod plus a `superRefine` pass for the cross-field rules above. Dotted arg paths (`"params.tokenIn"`) resolve through tuple components.
- [ ] **Step 6: Run** — tests pass; `pnpm --filter @repo/protocols typecheck && pnpm --filter @repo/protocols lint` clean.
- [ ] **Step 7: Commit** — `feat(protocols): add package with adapter types and validated manifest schema`

### Task 2: Declarative calldata decoder

**Files:**
- Create: `packages/protocols/src/manifest/decode.ts`, `src/manifest/decode.test.ts`, `src/manifest/index.ts`

**Interfaces:**
- Consumes: `Manifest`, `ManifestRef` (Task 1); `TxRequest`, `DecodedAction`, `DecodedApproval` (Task 1).
- Produces: `decodeAction(manifest: Manifest, tx: TxRequest, signer: Address): DecodedAction | null`; `decodeApproval(manifest: Manifest, tx: TxRequest): DecodedApproval | null`.

Rules (each is a test): unknown `to` → null; known `to`, unknown selector → null; malformed calldata → null (never throws); `recipient` arg present and ≠ signer → null; spend amount from `{arg}`, `{const}`, or `"msg.value"`; token from `{arg}`, `{const}` or `"native"`; a spend token that is not in the manifest's token list for the chain → null; `tx.value > 0` on a call with no `"msg.value"` spend → null (undeclared native spend); address comparison is case-insensitive; `decodeApproval` returns null unless `to` is a manifest token, the selector is `approve(address,uint256)`, and the spender is a manifest contract with role `router`; it reports `unlimited: true` when amount is `2^256-1` so callers can refuse it.

- [ ] Steps: failing tests → run RED → implement → run GREEN → typecheck + lint → commit `feat(protocols): add pure manifest-driven calldata decoder`.

### Task 3: Registry

**Files:**
- Create: `packages/protocols/src/registry/index.ts`, `src/registry/index.test.ts`

**Interfaces:**
- Produces: `createRegistry(manifests: unknown[]): Registry` where `Registry = { all(): Manifest[]; get(id: string): Manifest | undefined; forChain(chainId: number): Manifest[]; contracts(chainId: number): Map<Lowercase<string>, { protocol: string; key: string; role: string }>; decode(tx: TxRequest, signer: Address): DecodedAction | null }`. Throws `ProtocolError("INVALID_MANIFEST")` on a parse failure, a duplicate protocol id, or one contract address claimed by two protocols on the same chain.

- [ ] Steps: failing tests → RED → implement → GREEN → commit `feat(protocols): add manifest registry with cross-protocol collision checks`.

### Task 4: Vendor Iter's addresses and ABIs by script, and verify them onchain

**Files:**
- Create: `packages/protocols/scripts/vendor-iter.ts`, `scripts/verify-addresses.ts`
- Generated (committed): `src/iter/generated/deployments.ts`, `src/iter/abis/*.ts`, `registry/iter/manifest.json`
- Create: `src/iter/manifest.ts`, `src/iter/manifest.test.ts`

**Interfaces:**
- Produces: `ITER_DEPLOYMENTS` (per chain: `name`, `chainId`, `rpcUrl`, `nativeCurrency`, `gatewayUrl`, `explorerUrl`, `contracts[key] = { address, startBlock }`), `ITER_SOURCE_COMMIT`, `iterManifest: Manifest`, the six vendored ABI exports.

Facts the script relies on (from `iter-monorepo@91527db3`): `packages/deployments/deployments.json` keys chains by decimal string and is the ONLY address source (Iter's token list carries a retired engine address); ABIs are `as const` TypeScript in `packages/abis/src`; gateway URLs are `PonderLinks` in `apps/web/consts/index.ts`.

- [ ] **Step 1:** `vendor-iter.ts` checksums each address, requires `getCode` to be non-empty, probes the EIP-1967 implementation and admin slots to record the proxy type, reads each token's `symbol`/`name`/`decimals` ONCHAIN (only addresses are taken from the GPL-licensed token list), copies ABI files byte-for-byte, and preserves a hand-authored `actions` block across runs.
- [ ] **Step 2:** Keep these deployment entries OUT of the manifest's contract set: `weth` (a token; on Arc it is the USDC ERC-20 itself), `poolFactory` (alias of `bandPoolFactory`), `poolImplementation`, `batchExecutor`. The registry rejects the first two by construction.
- [ ] **Step 3:** `verify-addresses.ts` runs `cast code` for every vendored contract and token and exits non-zero on `0x`; the package's `test` script is `vitest run && tsx scripts/verify-addresses.ts` (spec §6.1).
- [ ] **Step 4:** Tests: manifest parses and registers; same contract keys on both chains; no token in the contract set; every manifest address equals the generated deployment address; Arc USDC is 6 decimals and canonical.
- [ ] **Step 5:** Commit — `feat(protocols): vendor Iter addresses and ABIs by script with onchain verification`

### Task 5: Iter adapter reads

**Files:**
- Create: `packages/protocols/src/iter/chains.ts`, `gateway.ts`, `reads.ts`, `index.ts`, `reads.test.ts`, `scripts/smoke-iter.mts`

**Interfaces:**
- Produces: `createIterAdapter(options?: { fetch?: FetchLike; timeoutMs?: number }): ProtocolAdapter` with reads `pools`, `quote`, `orderbook`, `orders`, `positions` (Iter's indexer gateway) and `tokenInfo`, `balances` (chain). `actions` is `{}` and `decode` returns null until the actions plan.

Facts: Iter has **no onchain quoter** (`BandSwapRouter.swap` is nonpayable); iter.cx quotes through `GET {gateway}/api/swap/route?network=<chain display name>&tokenIn&tokenOut&amountIn` with `amountIn` in whole token units. Other endpoints: `/api/pairs/{pageSize}/{page}`, `/api/orderbook/blocks/{base}/{quote}/{step}/{depth}/{isSingleSide}`, `/api/orders/{account}/{limit}/{page}`, `/api/liquidity/positions/{account}`. The RISE gateway returned 502 during research, so failure mapping is a first-class behaviour.

Rules (each is a test): gateway output is untrusted — 2 MB cap, 8 s timeout, zod-validated, every kept string passed through `clean()` (control, zero-width and bidi-override code points removed; length capped); upstream failure of any kind → `ProtocolError("TEMPORARILY_UNAVAILABLE")`; unknown chain → `UNSUPPORTED_CHAIN`; "no market" is returned as data with `available: false`; every quote carries `estimated: true`; exact quantities (`amountBN`, `sharesBN`) pass through as base-unit strings; per-user reads without `ctx.account` → `INVALID_INTENT`; inputs are bounded (page size ≤ 50, plain positive decimals only, no identical token pair); on a chain whose gas asset is a listed token (Arc), `balances` reports `gas` separately with `sameAssetAs` and never lists the native row.

- [ ] Steps: failing tests → RED → implement → GREEN → `pnpm --filter @repo/protocols smoke:iter 0 <account>` against Arc → typecheck + lint → commit `feat(protocols): add Iter adapter reads over the gateway and the chain`.

### Task 6: Gate and review

- [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm --filter @repo/web build && pnpm e2e`; marker grep from Plan 1 Task 7 Step 7 prints nothing new.
- [ ] Independent review (separate agent) of the package; address findings; commit.

---

## Design inputs recorded for the actions plan

- **Iter's swap cannot be decoded declaratively.** `BandSwapRouter.swap(address pool, uint256 amount, bool quoteToBase, address to, uint256 minOut)` names a pool and a direction, not tokens; the spent token is a function of the pool's pair. The guideline already allows custom decoder code for first-party adapters. The decoder will need a pool → (base, quote) fact that the frame can verify (`BandPoolFactory.getPool(base, quote)` is order-sensitive, so both orders are probed).
- **Approval spenders.** Only `swapRouter` has role `router` today. `matchingEngine` (limit orders) and `positionManager` (liquidity) also pull tokens; their roles are decided with their actions.
- **Launched coins are not manifest tokens.** A spend in an unlisted token decodes to null, so it is always confirm-tier. That is the safe default and matches spec §5.3 (a spending rule names one token).
- **Order price encoding:** limit `price` is in quote-token decimals; engine spreads and fees are 1e8-scaled (`DENOM`).
- **Licences:** `packages/abis` and `packages/deployments` declare no licence and derive from BUSL-1.1 sources; the token list is GPL-3.0-or-later. The owner of this project is the Iter licensor, so vendoring ABIs and addresses is theirs to permit; it is recorded here so it is a decision and not an accident.

## Self-review notes

- **Spec coverage:** §6 interface → Task 1. §15 manifest, decoder, registry invariant → Tasks 1–3. §6.1 chains, vendored ABIs/addresses with verification in `turbo test`, reads `quote`/`pools`/`orderbook`/`positions`/`tokenInfo`/`balances` → Tasks 4–5 (`orders` added because open orders are a separate endpoint from LP positions). §6.1 actions, approvals and slippage → the actions plan.
- **Deliberately out:** `McpProtocolAdapter`, the conformance command and the Custom tier (spec §15 places them after milestone 8); wiring `registry.contracts()` into `configureWallet({ knownContracts })`, which changes signing tiers and belongs with the rule engine.
