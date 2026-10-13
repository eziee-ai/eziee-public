"use client";

import { useSyncExternalStore } from "react";

/**
 * "Show me where to send the gas" — one sheet, opened from anywhere.
 *
 * ## Why a module store and not a context
 *
 * The thing that opens this is a toast action, raised from `lib/errors/toastContractError`
 * — a plain function, not a component, with no hook to call and no provider above it. A
 * context would mean every surface that can fail a write also has to mount a provider, and
 * this session has already broken two test files exactly that way: `useQueryClient` inside
 * a cancel button, and `wagmiConfig` at the top of the toast module. `useChainBrand` takes
 * the same shape for the same reason, and its docstring records why.
 *
 * So: a module-level store behind `useSyncExternalStore`. No provider, one subscriber
 * (`DepositPanel`, rendered by `/deposit`), and a plain `openGasDeposit()` any
 * function can call.
 *
 * ## It carries NOTHING
 *
 * The sheet reads the address itself through wagmi. Passing it in would mean every caller
 * holding a wallet hook it otherwise does not need — and would let a stale address reach a
 * QR code, which is the one value on that screen that must never be wrong.
 *
 * It used to hold a `chainId`, set from `/deposit?chainId=`, and the panel read
 * that as "deposit on this chain": it made the screen consider itself settled
 * and suppressed the asset list entirely. So one intent reached two different
 * screens depending on who linked, and the one reached from the account menu
 * had no asset list and no way back to one.
 *
 * The ASSET decides the network on that page — it is the first thing asked, and
 * a chain is not separately choosable. A request that names one is therefore
 * making a claim the page does not support, which is why the field is gone
 * rather than merely unused.
 *
 * What is left is a single question: is the deposit surface showing? The page
 * answers it on mount, and `DepositPanel` renders nothing until it does.
 */

let state = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Open the deposit surface. Safe to call from anywhere, including a toast action. */
export function openGasDeposit(): void {
  state = true;
  emit();
}

export function closeGasDeposit(): void {
  state = false;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSnapshot = (): boolean => state;
// The server has no store and must not render an open sheet, so it always sees false —
// same hydration rule the consent banner and the OG Pass countdown follow.
const getServerSnapshot = (): boolean => false;

export function useGasDeposit(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * The QR payload: EIP-681, so the CHAIN travels with the address.
 *
 * `ethereum:0x…@5042002` is what MetaMask, Rainbow and Trust parse into a prefilled send
 * on the right network. A bare address scans too, and is what a naive QR would contain —
 * but it says nothing about which chain, and a mobile wallet defaulting to Ethereum
 * mainnet sends real funds to an address whose keys exist only inside a passkey session on
 * a testnet. Losing the funds is the failure mode; a wallet that cannot parse the URI and
 * asks the user to pick the network is not.
 *
 * No amount is included. The fee is cents and the user may want to send more than one
 * transaction's worth.
 */
export function depositUri(address: string, chainId?: number): string {
  return chainId === undefined ? `ethereum:${address}` : `ethereum:${address}@${chainId}`;
}
