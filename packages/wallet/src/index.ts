"use client";

/**
 * The app's wallet interface. Every component imports from here, never from a
 * vendor SDK directly.
 *
 * ## Why the indirection
 *
 * Four swaps now — AppKit → Privy → AppKit → Privy → none. The first cost 17
 * files because there was no seam; every one since has cost two, because 15
 * components import these hooks rather than an SDK. The current answer is no
 * vendor at all: wagmi connectors, one of them a passkey account of our own.
 * Keep components off `wagmi/connectors` for the same reason they were kept off
 * the SDKs.
 *
 * ## What belongs behind it
 *
 * Connect/disconnect and account identity. **Not** transactions: `useWriteContract`,
 * `useSignTypedData` and `usePublicClient` come straight from wagmi and are
 * already vendor-neutral, because AppKit plugs in as a wagmi connector.
 * Wrapping those would be indirection with nothing behind it.
 *
 * ## `isConnected` is wagmi's, and now that is the only view there is
 *
 * Under a vendor there were two notions of "connected" — a session, and an
 * account able to sign — and 48 call sites gate transactions on the second. The
 * distinction has collapsed: a connector is connected exactly when it holds a
 * live account, so `isAuthenticated` mirrors `isConnected` again. It stays in
 * the interface because it costs nothing and the difference returns the moment
 * a session layer does.
 */

import { useCallback } from "react";
import { useConnect, useConnectors } from "wagmi";
import { toast } from "sonner";
import { MERA_CONNECTOR_ID } from "./meraConnector";
import { useAccount, useDisconnect } from "wagmi";

export interface WalletAccount {
  /** Checksummed EVM address, or undefined when nothing can sign. */
  address: `0x${string}` | undefined;
  /** An EVM account is connected and able to sign — wagmi's view. */
  isConnected: boolean;
  /**
   * Kept for call sites that distinguish "has a session" from "can sign".
   *
   * With AppKit the two collapse: connecting a wallet IS the session, so this
   * mirrors `isConnected`. It stays in the interface because the OG Pass signer
   * reintroduces a real difference — an account with a Turnkey signer can sign
   * without the wallet being connected at that moment.
   */
  isAuthenticated: boolean;
  /**
   * Connection is still being restored. Render neither state until false, or an
   * already-connected user sees a "Connect" flash on every page load.
   *
   * With `ssr: true` + `cookieToInitialState` this is usually already false on
   * first paint, which is the point of that setup.
   */
  isLoading: boolean;
  /**
   * This account signs through an embedded wallet Privy holds the key for, so
   * it can sign for ANY configured chain without a network-switch round trip.
   *
   * True when the active wallet's `walletClientType` is `privy` / `privy-v2`.
   * False for MetaMask and every other external wallet: those go through
   * EIP-1193, where the wallet itself must be on the chain first — that is the
   * wallet's constraint, not the vendor's, and no SDK removes it.
   *
   * The field was reserved and always-false under AppKit. It once meant "Privy
   * created this wallet" and now means something narrower and more useful:
   * a transaction can name its chain instead of asking the user to move.
   */
  hasSigner: boolean;
}

/** The connected account, as the app understands it. */
export function useWalletAccount(): WalletAccount {
  const { address, isConnected, status, connector } = useAccount();

  // "reconnecting" is the restore-from-storage path; "connecting" is a live
  // attempt. Both mean "not settled yet", and rendering either as disconnected
  // flashes a Connect button at an already-connected user on every page load.
  const isLoading = status === "reconnecting" || status === "connecting";

  return {
    address,
    isConnected,
    isAuthenticated: isConnected,
    isLoading,
    // Read off the ACTIVE connector, not a list of linked wallets: what decides
    // whether a chain switch is needed is which one is signing right now.
    hasSigner: connector?.id === MERA_CONNECTOR_ID,
  };
}

export interface WalletConnect {
  /** Connect the passkey account. */
  open: () => void;
  /**
   * REMOVED as a connector on 2026-09-07 — see `lib/providers.tsx`.
   *
   * A browser wallet is now a funding source, not a signer:
   * `lib/wallet/externalFunding.ts` sends from it to the passkey account over
   * EIP-1193, outside wagmi entirely. Nothing here can connect one, which is the
   * property that makes "the app always signs with the passkey" true by
   * construction rather than by review.
   */
  /**
   * Open the wallet's own account view — balance, funding, network switching.
   *
   * Distinct from `open()`, and the distinction matters: AppKit expressed this
   * as an argument to the SAME call, which is how the two got collapsed by
   * accident. Every call site is a Deposit button, and sending a connected user
   * to a "choose a wallet" dialog for the wallet they are already using is the
   * result. Privy keeps them separate as login() and fundWallet().
   */
  fund: () => void;
  /** End the session. */
  disconnect: () => void;
  ready: boolean;
}

/**
 * Did the USER decline, as opposed to something breaking?
 *
 * Two shapes, because two very different layers can produce a decline:
 *  - WebAuthn rejects a dismissed or timed-out prompt with a `DOMException`
 *    named `NotAllowedError` (and `AbortError` when the page aborts it);
 *  - an injected wallet rejects through EIP-1193 code 4001, which wagmi and
 *    viem surface as `UserRejectedRequestError`.
 *
 * Anything else is a real failure and must be visible. Erring toward "this was
 * an error" is the safe direction: a spurious toast is noticeable and fixable,
 * a swallowed one is what cost this an afternoon.
 */
function isUserCancellation(err: unknown): boolean {
  if (typeof DOMException !== "undefined" && err instanceof DOMException) {
    return err.name === "NotAllowedError" || err.name === "AbortError";
  }
  const e = err as { name?: string; code?: number; cause?: { code?: number } };
  return (
    e?.name === "UserRejectedRequestError" ||
    e?.code === 4001 ||
    e?.cause?.code === 4001
  );
}

/**
 * Turn a connect failure into something the user can act on.
 *
 * The one that matters is `PRF_UNAVAILABLE`, and its raw text — "Authenticator
 * did not enable PRF" — names an extension almost nobody has heard of while
 * saying nothing about what to do. PRF is what turns a passkey into a private
 * key here, so an authenticator without it cannot hold a wallet at all.
 *
 * The message says that, and says what to do: pick a different provider at the
 * prompt. `webauthnClient.ts` raises a more specific version naming the
 * transports of whatever actually answered.
 *
 * It also warns that a passkey WAS created. mera checks PRF only after
 * `navigator.credentials.create()` has already succeeded, so the authenticator
 * has stored a credential this app can never use — and every retry stores
 * another. Someone left staring at a list of identical "eziee wallet" entries
 * deserves to know where they came from.
 */
/** The innermost message on the `cause` chain, which is where a wrapper hides it. */
function causeMessage(err: unknown): string | undefined {
  let cur: unknown = (err as { cause?: unknown })?.cause;
  let last: string | undefined;
  // Bounded: a cyclic or absurdly deep chain must not hang the click handler.
  for (let i = 0; i < 5 && cur; i++) {
    if (cur instanceof Error && cur.message) last = cur.message;
    cur = (cur as { cause?: unknown })?.cause;
  }
  return last;
}

function describeConnectError(err: unknown): { title: string; description: string } {
  const code = (err as { code?: unknown })?.code;

  if (code === "PRF_UNAVAILABLE") {
    return {
      title: "This passkey cannot hold a wallet",
      description:
        "Your passkey provider does not support the WebAuthn PRF extension, which is what derives the key. " +
        "Choose a different provider when asked where to save — a phone, a security key, or another " +
        "password manager. Note a passkey may already have been created and cannot be used; you can delete it.",
    };
  }
  if (code === "PASSKEY_OPERATION_FAILED") {
    // mera wraps ANY non-MeraError from the ceremony in this code and replaces
    // the message with "Passkey creation failed" — so the real reason, including
    // the one webauthnClient.ts raises naming the authenticator's transports,
    // survives only on `cause`. Printing the wrapper alone throws away the only
    // sentence that says what happened.
    const cause = causeMessage(err);
    return {
      title: "The passkey could not be used",
      description:
        cause ??
        "The authenticator refused the request. If this passkey was created on another site or another " +
          "device, it does not exist for this one — passkeys are scoped to a domain.",
    };
  }
  if (code === "CRYPTO_UNAVAILABLE") {
    return {
      title: "This browser cannot create a wallet",
      description: "WebCrypto is unavailable. That usually means an insecure origin — passkeys need HTTPS or localhost.",
    };
  }

  return {
    title: "Could not connect",
    description: err instanceof Error ? err.message : String(err),
  };
}

export function useWalletConnect(): WalletConnect {
  const { connectAsync, isPending } = useConnect();
  const { disconnect: wagmiDisconnect } = useDisconnect();
  const { isConnected } = useAccount();
  const connectors = useConnectors();

  const connectWith = useCallback(
    (id: string) => {
      const connector = connectors.find((c) => c.id === id);
      if (!connector) return;
      // Both connectors need a user gesture — the passkey prompt is refused
      // without one, and an injected wallet opens its own window. This is only
      // ever called from a click for that reason.
      void connectAsync({ connector }).catch((err: unknown) => {
        // Dismissing a passkey sheet or a wallet popup is a decision, not a
        // failure, and a toast for "no thanks" is noise.
        //
        // But this `catch` used to swallow EVERYTHING, and that made every real
        // failure look identical to a cancellation: the button clicked, nothing
        // happened, nothing logged, nothing shown. A passkey whose authenticator
        // cannot do PRF, a stored credential from another origin (the connector
        // throws "That passkey is no longer available on this device." by
        // design), a browser without WebAuthn — all silent. Reported as
        // "connected wallet with passkey and nothing happened", which is exactly
        // what the code did.
        if (isUserCancellation(err)) return;
        console.error("[wallet] connect failed", err, "cause:", (err as { cause?: unknown })?.cause);
        const { title, description } = describeConnectError(err);
        toast.error(title, { description, duration: 12_000 });
      });
    },
    [connectAsync, connectors],
  );

  /**
   * Connect the passkey account.
   *
   * There is no vendor modal to open any more, so this connects directly rather
   * than presenting a chooser. A chooser between "passkey" and "injected wallet"
   * is real UI that belongs in a component, not behind this hook — see the
   * wallet-modal design.
   */
  const open = useCallback(() => connectWith(MERA_CONNECTOR_ID), [connectWith]);

  const fund = useCallback(() => {
    // No vendor on-ramp exists now. Connecting is the honest first step when
    // nobody is connected; beyond that, funding is a deposit flow this app owns
    // and does not have yet — so this deliberately does nothing rather than
    // opening something that cannot fund anything.
    if (!isConnected) open();
  }, [isConnected, open]);

  const disconnect = useCallback(() => {
    // Ends the mera session too: the connector's disconnect() zeroes the key.
    wagmiDisconnect();
  }, [wagmiDisconnect]);

  return { open, fund, disconnect, ready: !isPending };
}

