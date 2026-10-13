"use client";

import { useCallback, useSyncExternalStore } from "react";
import { useWalletAccount } from "./index";

/**
 * "This needs a wallet" — asked from anywhere, answered in one dialog.
 *
 * ## The gap this closes
 *
 * The connect chooser existed, but it was local `useState` inside
 * `Shell/WalletButton`, so the ONLY way to reach it was clicking that button.
 * Every other gated control had to invent its own answer, and what they did
 * instead was call the write and hope: `StarButton` awaited
 * `addToWatchlist(...)` with no signed-in check and no catch, so a visitor with
 * no wallet clicking a star got an unhandled rejection in the console and
 * nothing on screen. Not a broken star — a broken page, from a control whose
 * only job is a bookmark.
 *
 * ## Why a module store and not a provider
 *
 * `StarButton` renders on every market row, and `ChainBadge` already taught this
 * codebase what a provider requirement costs a component at that density: it
 * gives something whose only job is a small interaction the power to take down
 * whatever mounts it, and it broke twelve component tests when tried. So this is
 * the same shape `useChainBrand` settled on — a module-level store behind
 * `useSyncExternalStore`, no provider, and any existing test that mounts a gated
 * control keeps passing without being wrapped in anything.
 *
 * The dialog itself is mounted ONCE (`AppShell`). A per-caller dialog would put
 * N copies in the tree and stack them.
 */
export type ConnectRequest = {
  open: boolean;
  /** Why the wallet is needed, in the caller's own words. Shown in the dialog. */
  reason?: string;
};

const CLOSED: ConnectRequest = { open: false };

let state: ConnectRequest = CLOSED;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Open the connect dialog. Safe to call from an event handler on any surface. */
export function requestWalletConnect(reason?: string): void {
  state = { open: true, reason };
  emit();
}

export function closeWalletConnect(): void {
  if (!state.open) return;
  state = CLOSED;
  emit();
}

/**
 * Exported because `useSyncExternalStore` needs them and because they ARE the
 * store's contract — the behaviour worth pinning (no notification on a no-op
 * close, one request at a time) lives here, not in the React binding.
 */
export function subscribeConnectRequest(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const readConnectRequest = (): ConnectRequest => state;
// The server has no pending request, and returning a fresh object here would
// make `useSyncExternalStore` loop — the snapshot must be referentially stable.
const getServerSnapshot = (): ConnectRequest => CLOSED;

/** For the single mounted dialog. Nothing else should need this. */
export function useConnectRequest(): ConnectRequest {
  return useSyncExternalStore(subscribeConnectRequest, readConnectRequest, getServerSnapshot);
}

/**
 * Gate an action behind a connected wallet.
 *
 * ```ts
 * const requireWallet = useRequireWallet();
 * onClick={() => requireWallet(() => void save(), "Sign in to use your watchlist")}
 * ```
 *
 * Returns whether the wallet was already connected, so a caller that needs to
 * bail out of a larger handler can branch on it rather than relying on `action`
 * having run.
 *
 * The action is NOT replayed after connecting. Connecting a passkey is a
 * deliberate, multi-second ceremony, and firing a write the moment it completes
 * — against a control the visitor may have clicked exploratively, on a page they
 * may have scrolled away from — is a worse surprise than asking them to click
 * the star again now that it works.
 */
export function useRequireWallet(): (action?: () => void, reason?: string) => boolean {
  const { isConnected } = useWalletAccount();

  return useCallback(
    (action?: () => void, reason?: string) => {
      if (isConnected) {
        action?.();
        return true;
      }
      requestWalletConnect(reason);
      return false;
    },
    [isConnected],
  );
}
