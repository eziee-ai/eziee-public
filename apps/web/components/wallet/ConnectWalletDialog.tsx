"use client";

import { WalletCards } from "lucide-react";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { BRAND } from "@repo/ui/brand";
import { useWalletConnect } from "@repo/wallet";
import { closeWalletConnect, useConnectRequest } from "@repo/wallet/connectGate";

/**
 * The connect-or-create chooser, mounted ONCE and opened from anywhere.
 *
 * Lifted out of `Shell/WalletButton`, where it was local state and therefore
 * reachable only by clicking that one button. Every other control that needs a
 * wallet — the watchlist star today, and whatever is gated next — now opens this
 * through `requestWalletConnect` instead of inventing its own handling. See
 * `lib/wallet/connectGate` for why the request is a module store rather than a
 * provider.
 *
 * Everything below is the markup that already shipped, including the copy
 * decisions, which are load-bearing and were argued once:
 *
 *   * "Connect or create a wallet", not "Log in or sign up" — there is no
 *     account to log into, no email, no password, no server-side identity. Both
 *     options produce a WALLET. Login language promises a credential this venue
 *     has never had and sets the wrong expectation about recovery.
 *   * A visible way out, worded as the visitor's own decision. Escape and the
 *     backdrop both dismiss, but neither is an affordance, and a dialog whose
 *     only exits are invisible reads as a wall. Most of the venue is readable
 *     without a wallet.
 *   * Each option says what it means FOR CHAINS, because on this venue that is
 *     the one way the two genuinely differ in daily use, and it is invisible
 *     until the first trade. READING is multichain either way — the aggregator
 *     serves every chain over HTTP and no wallet is involved. SIGNING is not: an
 *     injected wallet signs only for its current network, so trading a market on
 *     another chain interrupts with a switch prompt. The passkey connector names
 *     the chain in each transaction (see `lib/wallet/meraConnector.ts`), so it
 *     has no ambient current network to be wrong and never asks.
 *
 *     Said HERE rather than at the switch prompt because this is where the
 *     choice is actually made: someone picking an extension is choosing that
 *     prompt for every cross-chain trade they will ever make. One clause each
 *     and not a comparison table — the dialog's job is still to get them a
 *     wallet, not to argue a case.
 */
const subscribeToNothing = () => () => {};

export function ConnectWalletDialog() {
  const { open: connectPasskey } = useWalletConnect();
  const { open, reason } = useConnectRequest();
  const box = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  // Portals need a document, which the server render does not have.
  // False on the server and during hydration, true afterwards, with no effect-driven setState.
  const mounted = useSyncExternalStore(subscribeToNothing, () => true, () => false);

  // Escape closes, and focus lands on the first option. A dialog that opens
  // without moving focus leaves a keyboard user tabbing through the page behind
  // it; one that cannot be dismissed by Escape traps them there.
  useEffect(() => {
    if (!open) return;
    first.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeWalletConnect();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open || !mounted) return null;

  return createPortal(
    /* Rendered into <body>, not in place. `position: fixed` resolves against the
       nearest ancestor with a transform, filter or backdrop-filter — and the
       original mount sat inside the shell's blurred top bar, which is exactly
       such an ancestor. Left in the tree, the dialog centred on that bar and
       hung off the top of the screen. */
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      role="presentation"
      onMouseDown={(event) => {
        // Backdrop only. Without the target check, a mousedown that starts
        // inside the dialog and drifts out closes it mid-interaction.
        if (event.target === event.currentTarget) closeWalletConnect();
      }}
    >
      <div aria-hidden className="absolute inset-0 bg-black/55 backdrop-blur-sm" />

      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-labelledby="wallet-dialog-title"
        className="relative w-full max-w-[380px] rounded-3xl border border-[color:var(--m-border)] bg-[color:var(--m-surface)] p-6 shadow-2xl"
      >
        <div className="mb-5 flex items-center gap-2.5">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-[color:var(--m-primary)] text-[color:var(--m-on-primary)]">
            <WalletCards className="h-4 w-4" />
          </span>
          <span className="font-semibold tracking-tight text-[color:var(--m-text-primary)]">{BRAND}</span>
        </div>

        <h2
          id="wallet-dialog-title"
          className="text-lg font-semibold tracking-tight text-[color:var(--m-text-primary)]"
        >
          Connect or create a wallet
        </h2>

        {/* The caller's reason, when it gave one. This is what makes the dialog
            answer "why am I being asked?" for a visitor who clicked a star, not
            the wallet button — without it, an unexplained modal appearing over a
            bookmark reads as the page misfiring. */}
        <p className="mt-1 text-[13px] text-[color:var(--m-text-secondary)]">
          {reason ?? `Trade on ${BRAND} with a wallet that is yours alone.`}
        </p>

        <button
          ref={first}
          type="button"
          data-testid="connect-passkey"
          onClick={() => {
            closeWalletConnect();
            connectPasskey();
          }}
          className="mt-5 flex w-full flex-col items-start gap-0.5 rounded-2xl bg-[color:var(--m-primary)] px-4 py-3 text-left transition-colors hover:bg-[color:var(--m-primary-hover)]"
        >
          <span className="text-sm font-semibold text-[color:var(--m-on-primary)]">Continue with a passkey</span>
          <span className="text-[12px] text-[color:var(--m-on-primary)]/80">
            Face ID or a security key. No seed phrase, and no network switching —
            it works on every chain {BRAND} serves.
          </span>
        </button>

        {/* A browser wallet is no longer an option HERE, because it is no longer a
            signer — see `lib/providers.tsx`. It reappears at the moment it is
            actually useful: funding this account, on `/deposit`, where one
            transaction on one chain is exactly what an injected wallet is good at.

            Saying so on this screen would be answering a question nobody has yet.
            A visitor who has not got a wallet is not yet wondering how to move
            money into one. */}
        <button
          type="button"
          data-testid="connect-dismiss"
          onClick={() => closeWalletConnect()}
          className="mt-4 w-full rounded-2xl px-4 py-2.5 text-[13px] font-medium text-[color:var(--m-text-secondary)] transition-colors hover:bg-[color:var(--m-surface-2)] hover:text-[color:var(--m-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--m-primary-fg)]"
        >
          I&rsquo;ll just look around
        </button>

        <p className="mt-3 border-t border-[color:var(--m-border)] pt-3 text-center text-[11.5px] text-[color:var(--m-text-secondary-2)]">
          {BRAND} never holds your keys.
        </p>
      </div>
    </div>,
    document.body,
  );
}
