# Plan 3 — Deposit and Withdraw Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A connected user can see their full deposit address with a QR code, fund the wallet from a browser wallet, and withdraw any listed asset through a previewed, irreversible-warned transfer that the wallet frame confirms.

**Architecture:** Hybrid port. The money-critical pure libraries are **copied** from Iter with their tests (max-amount math with Arc's 18-to-6 gas conversion, EIP-681 URI, raw EIP-1193/EIP-6963 funding, address validation, local receipts, address book, amount input, clipboard). The two large Iter panels are **not** ported: they are interleaved with Iter's indexer-backed asset discovery, chain-brand stores, the fee split, CCTP and locale routing, none of which exist here. The screens are rebuilt small on top of the copied libraries and `@repo/protocols` (token list and balances). Every transfer is confirm-tier and is signed only by a click inside the wallet frame (spec §5.3 step 1).

**Tech Stack:** as Plan 1, plus `@repo/protocols`, `qrcode` 1.5.3, Playwright with a JSON-RPC mock.

**Spec:** `docs/superpowers/specs/2026-09-18-agentic-trading-chat-design.md` §8 (not §8.1, which is gated off on testnets), §10 wallet and revert rows, build-order milestone 4. Research: `.omc/research/2026-09-20-transfer-port-map.md`.

## Global Constraints

- Branch `feat/plan-3-transfers` from `feat/plan-2-protocols`.
- Copy with `cp`, then apply only listed edits: `@/lib/customChains` `wagmiChains` → `@/lib/chains` `appChains`; `@/utils/numberInput` → `./numberInput`; `@/lib/wallet/walletFailure` → `@repo/wallet/walletFailure`; product name → `BRAND`; storage keys `iter.transfers` → `wlt.transfers`, `iter.address-book` → `wlt.address-book`.
- Dropped by spec: CCTP, `ClaimDeposit`, the fee split, server-side history.
- Addresses are shown in full everywhere a user may copy or verify one. Decimals are never assumed.
- Every commit message ends with: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`

---

### Task 1: Copy the pure libraries with their tests
- [x] `apps/web/lib/transfer/{depositMax,gasDeposit,externalFunding,withdraw,history,addressBook,withdrawError,numberInput,clipboard}.ts` and tests (`externalFunding`'s test is `fundingConnect.test.ts`). 94 ported tests pass.

### Task 2: Withdrawal validation and request building (new, test-first)
- [x] `lib/transfer/withdrawForm.ts`: `validateWithdraw` names the field at fault and refuses a shortened address, a failed EIP-55 checksum, the zero address, the sending wallet, the token contract as recipient, more decimals than the token has, more than held, and more than the gas-adjusted maximum. `buildWithdrawRpc` emits a native send or an exact ERC-20 `transfer`.

### Task 3: Assets, shell and screens
- [x] `useTransferAssets` reads balances through the Iter adapter, so Arc's gas USDC is never listed beside the USDC token. A failed read shows an error with Retry; it never looks like an empty wallet.
- [x] `/deposit`: asset list, black-on-white QR of the EIP-681 URI, full address with copy, this-network-only warning, browser-wallet funding with named steps, faucet link on testnets.
- [x] `/withdraw`: asset → amount with Max → recipient with recents → Preview → irreversibility notice → `WalletConfirmFrame` → result card (confirming, confirmed, reverted, not confirmed yet). Receipts are recorded on the device only.
- [x] `AppHeader` navigation.

### Task 4: End-to-end tests with a JSON-RPC mock
- [x] `e2e/rpcMock.ts` answers reads (including `Multicall3.aggregate3` and `getEthBalance`), fee estimation, broadcast and receipts. `e2e/transfers.spec.ts`: deposit address, QR and single USDC row on Arc; field-level validation; Max leaves the fee; **the raw transaction the frame broadcast is parsed and must equal the previewed transfer**; a reverted receipt is reported as reverted.

### Task 5: Gate and review
- [x] `pnpm typecheck && pnpm lint && pnpm test && pnpm --filter @repo/web build && pnpm e2e`; marker scan clean.
- [ ] Independent review; address findings.

## Findings during execution
- wagmi's `useWaitForTransactionReceipt` throws on a reverted receipt, which left the result card on "Confirming". Replaced with viem's `waitForTransactionReceipt`.
- wagmi batches reads through Multicall3, and newer viem reads the native balance through it too; the RPC mock implements both.
