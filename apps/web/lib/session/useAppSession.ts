"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useSignMessage } from "wagmi";
import { BRAND } from "@repo/ui/brand";
import { useWalletAccount } from "@repo/wallet";
import { signInMessage } from "@repo/wallet/signIn";
import { signInStore } from "./signInStore";

export interface AppSession {
  address: string | null;
  /** On the server's admin list: may open /admin. */
  admin?: boolean;
  /** `minHoldMicrousd` and `sendFloorMicrousd` (what one send of the default model needs) are left out when the server cannot work them out. */
  credit?: { spendableMicrousd: string; heldMicrousd: string; minHoldMicrousd?: string; sendFloorMicrousd?: string; blocked: boolean };
}

async function readSession(): Promise<AppSession> {
  const response = await fetch("/api/auth/session", { cache: "no-store" });
  if (!response.ok) throw new Error("session");
  return (await response.json()) as AppSession;
}

/**
 * The server session for the connected wallet (spec §9.1).
 *
 * Signing in needs no prompt: the wallet frame signs this one exact message
 * silently, because it IS this app's sign-in template for this account and this
 * site. So as soon as a wallet is connected and the server does not know it,
 * sign-in runs by itself. Several components use this hook at once; the
 * sign-in itself lives in `signInStore`, so it still happens once.
 */
export function useAppSession() {
  const queryClient = useQueryClient();
  const { address, isConnected } = useWalletAccount();
  const { signMessageAsync } = useSignMessage();
  const session = useQuery({ queryKey: ["app-session"], queryFn: readSession, staleTime: 30_000 });
  const { signingIn, error } = useSyncExternalStore(signInStore.subscribe, () => signInStore.state(address), () => signInStore.state(undefined));

  const run = useCallback(
    async (account: `0x${string}`) => {
      const nonceResponse = await fetch("/api/auth/nonce", { method: "POST" });
      if (!nonceResponse.ok) throw new Error("Sign-in could not start. Try again.");
      const { nonce } = (await nonceResponse.json()) as { nonce: string };
      const message = signInMessage({ brand: BRAND, address: account, origin: window.location.origin, nonce, issued: new Date().toISOString() });
      const signature = await signMessageAsync({ account, message });
      const verify = await fetch("/api/auth/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: account, message, signature }) });
      if (!verify.ok) throw new Error("Sign-in could not be verified. Try again.");
      await queryClient.invalidateQueries({ queryKey: ["app-session"] });
    },
    [queryClient, signMessageAsync],
  );

  const signedInAs = session.data?.address?.toLowerCase() ?? null;
  const matches = Boolean(address && signedInAs === address.toLowerCase());

  // Also covers a server session that expired while the tab stayed open: the session query says "nobody", and this runs again.
  useEffect(() => {
    if (!isConnected || !address || session.isLoading || session.isFetching || matches) return;
    void signInStore.ensure(address, () => run(address));
  }, [isConnected, address, session.isLoading, session.isFetching, matches, run]);

  return {
    /** Signed in on the server AS the connected wallet. */
    signedIn: matches,
    address: matches ? address : undefined,
    credit: matches ? session.data?.credit : undefined,
    admin: matches && session.data?.admin === true,
    isSigningIn: signingIn,
    error,
    retry: () => (address ? signInStore.retry(address, () => run(address)) : Promise.resolve()),
    refresh: () => queryClient.invalidateQueries({ queryKey: ["app-session"] }),
  };
}
