"use client";

/**
 * A wagmi connector backed by the passkey account — with the key on another
 * origin.
 *
 * ## Why a connector rather than a side channel
 *
 * 48 call sites in this app gate on wagmi's `isConnected`, and every write goes
 * through `useWriteContract`. A signer the connector layer does not know about
 * is a signer none of that can see. Wrapping the passkey account as a
 * connector is what makes it a first-class wallet everywhere, with no call
 * site changed.
 *
 * ## The account is LOCAL to the wallet frame, not to this document
 *
 * Until 2026-09-18 this connector held a viem `LocalAccount` in a closure and
 * signed in-process. It now holds an ADDRESS and a handle on the wallet frame
 * (`lib/wallet/frame/client.ts`), a hidden iframe on the wallet origin that
 * keeps the key and does every signature. Script on this origin — including
 * an XSS — can ask the frame to sign; it cannot read the key, cannot read the
 * frame's storage, and cannot keep anything past the tab.
 *
 * Signing is still a pure computation from the app's point of view: a
 * transaction names its chain and the frame signs for it, so `switchChain`
 * cannot fail and never prompts. That property is what let the injected
 * connector go (see `lib/providers.tsx`) and it is unchanged.
 *
 * ## Reconnect must not prompt
 *
 * `WagmiProvider` runs `reconnect` on every mount with `isReconnecting: true`
 * — a page load, with no user gesture. A WebAuthn prompt from there is refused
 * by the browser, which throws, and wagmi answers a failed reconnect by
 * clearing the connection: the "connected then immediately disconnected" bug.
 * So reconnect takes the one path that cannot prompt — `frame.resume()`, which
 * decrypts a key the frame already holds — and throws when there is nothing
 * to resume, exactly as before.
 *
 * ## The confirm tier is not this connector's to sign
 *
 * A request the frame's policy sorts as value-moving (`frame/policy.ts`) is
 * refused here with `CONFIRM_REQUIRED` and goes through the visible confirm
 * frame instead (`components/Wallet/WalletConfirmFrame`). `useWriteContract`
 * on an ERC-20 `transfer` therefore FAILS on this connector, loudly — which is
 * the correct outcome for a path that would otherwise sign a withdrawal with
 * no human in the loop.
 */

import { createConnector } from "wagmi";
import { createWalletClient, http, type Address, type EIP1193RequestFn, type Hex } from "viem";
import { walletChains } from "./config";
import { createPasskeyKey, hasMeraCredential, unlockPasskeyKey } from "./mera";
import { endMeraSession } from "./meraSession";
import { walletFrame, type WalletFrame } from "./frame/client";
import { isIsolated } from "./frame/origins";
import { ERR, WalletFrameError } from "./frame/protocol";

export const MERA_CONNECTOR_ID = "mera";

type Provider = { request: EIP1193RequestFn };

function chainById(id: number) {
  const chain = walletChains().find((c) => c.id === id);
  if (!chain) throw new Error(`Chain ${id} is not configured`);
  return chain;
}

/** The methods that reach the frame. Everything else is a read the chain answers. */
const SIGNING_METHODS = new Set(["personal_sign", "eth_signTypedData_v4", "eth_signTypedData", "eth_sendTransaction"]);

export function meraConnector(params: {
  /** Shown by the authenticator when the user picks a passkey. */
  userName: () => string;
  /** Injectable for tests; the real one is the hidden iframe. */
  frame?: WalletFrame;
}) {
  const frame = params.frame ?? walletFrame;
  let address: Address | null = null;
  let chainId: number = walletChains()[0].id;

  // One provider for the connector's life, and it EXISTS while locked. wagmi's
  // reconnect() calls getProvider() before isAuthorized() and skips a connector
  // whose getProvider() rejects, so throwing "locked" there meant a page load
  // never reached frame.resume() and every reload dropped a live session.
  // The lock is checked per request instead, against the current address, so a
  // provider obtained before a lock cannot keep answering for the old account.
  const provider: Provider = {
    request: (async (args: { method: string; params?: unknown }) => {
      if (!address) throw new Error("Passkey wallet is locked.");
      return makeRequest(address, () => chainId, frame)(args as never);
    }) as EIP1193RequestFn,
  };

  return createConnector<Provider>((config) => ({
    id: MERA_CONNECTOR_ID,
    name: "Passkey",
    type: "mera" as const,

    async setup() {
      // A session stored by the pre-frame connector lives on THIS origin, in
      // exactly the form the frame now keeps on its own. Once the frame is
      // isolated that record is unreachable by anything legitimate and is one
      // XSS away from being read — so it goes, both halves, on first load.
      // Not when same-origin: there the frame IS this storage.
      if (typeof window !== "undefined" && isIsolated()) endMeraSession();
    },

    async connect<withCapabilities extends boolean = false>(
      parameters?: { chainId?: number; isReconnecting?: boolean; withCapabilities?: withCapabilities | boolean },
    ) {
      const requested = parameters?.chainId;

      if (parameters?.isReconnecting) {
        try {
          address = await frame.resume();
        } catch (err) {
          address = null;
          throw err instanceof WalletFrameError && err.code === ERR.LOCKED
            ? new Error(
                "The passkey session has expired. Connect again to unlock it — " +
                  "restoring it needs a tap, which a page load cannot ask for.",
              )
            : err;
        }
        if (requested) chainId = requested;
        return accountsResult(address, chainId, parameters?.withCapabilities);
      }

      // A live session resumes without any ceremony here too: a user who clicks
      // Connect within the window should not be asked for a passkey they
      // already tapped for today.
      address = await frame.resume().catch((err: unknown) => {
        if (err instanceof WalletFrameError && err.code === ERR.LOCKED) return null;
        throw err;
      });

      if (!address) {
        // An existing pointer means "unlock" and its absence means "create".
        // Both prompt, and both must be reached from a click — wagmi's
        // connect() is, so this is safe here and would not be from setup().
        const prfOutput = hasMeraCredential()
          ? await unlockPasskeyKey()
          : await createPasskeyKey({ name: params.userName() });

        if (!prfOutput) {
          // A stored pointer that no longer resolves: the passkey was deleted,
          // or this is a different origin. Falling back to creation silently
          // would mint a SECOND account and strand the first.
          throw new Error("That passkey is no longer available on this device.");
        }

        try {
          // The frame derives the address, wraps the key, and starts the clock.
          address = await frame.unlock(prfOutput);
        } finally {
          // This origin's copy is done the moment the frame has it.
          prfOutput.fill(0);
        }
      }

      if (requested) chainId = requested;
      return accountsResult(address, chainId, parameters?.withCapabilities);
    },

    async disconnect() {
      address = null;
      // Disconnecting is the user saying this browser should stop being able to
      // sign; the frame drops the stored session, both halves.
      await frame.disconnect().catch(() => {});
    },

    async getAccounts() {
      return address ? ([address] as readonly Address[]) : [];
    },

    async getChainId() {
      return chainId;
    },

    async isAuthorized() {
      // A stored session that has not expired, as the frame reports it. This is
      // only a claim that reconnect will probably succeed; the decrypt can
      // still fail, and connect() reports that honestly when it does.
      if (address) return true;
      try {
        const status = await frame.status();
        return status.address !== null;
      } catch {
        return false;
      }
    },

    async switchChain({ chainId: next }) {
      const chain = chainById(next);
      // No prompt and nothing can refuse: the frame signs for whichever chain
      // the transaction names.
      chainId = next;
      config.emitter.emit("change", { chainId: next });
      return chain;
    },

    async getProvider() {
      return provider;
    },

    onAccountsChanged() {
      // A local account cannot change underneath us.
    },
    onChainChanged() {},
    onDisconnect() {
      address = null;
      void frame.disconnect().catch(() => {});
    },
  }));
}

function accountsResult<withCapabilities extends boolean>(
  address: Address,
  chainId: number,
  withCapabilities?: withCapabilities | boolean,
) {
  const accounts = withCapabilities ? [{ address, capabilities: {} }] : [address];
  return { accounts, chainId } as unknown as {
    accounts: withCapabilities extends true
      ? readonly { address: Address; capabilities: Record<string, unknown> }[]
      : readonly Address[];
    chainId: number;
  };
}

/**
 * A minimal EIP-1193 surface. Signing methods go to the frame; identity
 * methods are answered here; everything else is forwarded to the chain's own
 * RPC rather than silently returning undefined.
 */
function makeRequest(address: Address, getChainId: () => number, frame: WalletFrame): EIP1193RequestFn {
  return (async ({ method, params }: { method: string; params?: unknown }) => {
    switch (method) {
      case "eth_accounts":
      case "eth_requestAccounts":
        return [address];

      case "eth_chainId":
        return `0x${getChainId().toString(16)}` as Hex;

      default: {
        if (SIGNING_METHODS.has(method)) {
          return frame.request(getChainId(), { method, params });
        }
        const chain = chainById(getChainId());
        const rpc = createWalletClient({ chain, transport: http() });
        return rpc.request({ method, params } as never);
      }
    }
  }) as EIP1193RequestFn;
}

/** Unused today; kept so the import surface reads as intended. */
export type { Provider as MeraProvider };
