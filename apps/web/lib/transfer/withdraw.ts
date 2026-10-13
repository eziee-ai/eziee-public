"use client";

import { useSyncExternalStore } from "react";

/**
 * The withdraw sheet's open/closed state, as a module store.
 *
 * Same shape and same reasoning as `lib/wallet/gasDeposit`: mounted ONCE in
 * AppShell and opened from anywhere, so every surface that needs it shares one
 * dialog rather than each inventing its own. A provider would work too and would
 * mean every consumer re-renders on a state nearly none of them read.
 */
/*
 * ## It carries nothing
 *
 * There was a `chainId` here, to preselect a network. Nothing ever set it —
 * `/withdraw` opens with `{}` and it had no other caller — and the panel does
 * not want one: the ASSET settles the chain there now, exactly as on the
 * deposit page, because every candidate already carries its network and two
 * separate answers could disagree.
 *
 * Its one visible effect was a bug. `WithdrawView` passed `request?.chainId`
 * to `TransferShell`, so the network guard on this page was fed `undefined`
 * forever and could never warn about a wallet standing on another chain. The
 * panel reports the chosen asset's chain instead.
 */

let open = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function openWithdraw(): void {
  open = true;
  emit();
}

export function closeWithdraw(): void {
  open = false;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useWithdraw(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => open,
    // The server has no open dialog, and returning `open` here would make the
    // first client render disagree with the HTML it is hydrating.
    () => false,
  );
}

/**
 * Is this a plausible destination for an irreversible transfer?
 *
 * Deliberately strict about SHAPE only — nothing can tell whether an address is
 * one the user controls, and pretending otherwise would be the wrong kind of
 * reassurance. What it does catch is the mistake that actually happens: a
 * truncated paste. A UI address is routinely displayed as `0x38A1…7f0A`, and
 * pasting that produces a well-formed-looking string that is not an address.
 */
export function isPlausibleAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value.trim());
}

/**
 * Refuse a withdrawal to the wallet it is coming FROM.
 *
 * It would succeed, cost a fee and change nothing, which reads as a bug rather
 * than as the no-op it is.
 */
export function isSelfSend(from: string | undefined, to: string): boolean {
  if (!from) return false;
  return from.trim().toLowerCase() === to.trim().toLowerCase();
}
