"use client";

// Required: meraConnector() below reads the wallet config when it is called, so configureWallet() must have run by then.
import "./walletSetup";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Toaster } from "sonner";
import { http } from "viem";
import { createConfig, useReconnect, WagmiProvider } from "wagmi";
import { meraConnector } from "@repo/wallet/meraConnector";
import { BRAND } from "@repo/ui/brand";
import { appChains } from "./chains";

export const wagmiConfig = createConfig({
  chains: appChains,
  connectors: [meraConnector({ userName: () => `${BRAND} wallet` })],
  // Load-bearing: EIP-6963 auto-discovery would otherwise promote an injected
  // wallet to the active account when the deposit sheet calls eth_requestAccounts.
  multiInjectedProviderDiscovery: false,
  transports: Object.fromEntries(appChains.map((c) => [c.id, http()])) as Record<(typeof appChains)[number]["id"], ReturnType<typeof http>>,
  ssr: true,
});

// WagmiProvider's own reconnect turns a rejection into an unhandled rejection;
// the hook turns it into mutation state instead.
//
// Runs exactly once. A second reconnect while one is in flight (React's dev
// double-mount, or a changed `reconnect` identity) connects and then immediately
// disconnects, so a reload lands on the connect button despite a live session.
function ReconnectOnMount() {
  const { reconnect } = useReconnect();
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    reconnect();
  }, [reconnect]);
  return null;
}

export function Providers({ children, nonce }: { children: ReactNode; nonce?: string }) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    // `nonce` is next-themes' own escape hatch for its pre-hydration inline
    // script: it is injected via dangerouslySetInnerHTML, so Next's automatic
    // per-chunk nonce tagging never touches it, and without one the app's
    // nonce + strict-dynamic script-src would flag it.
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange nonce={nonce}>
      <WagmiProvider config={wagmiConfig} reconnectOnMount={false}>
        <QueryClientProvider client={queryClient}>
          <ReconnectOnMount />
          {children}
          <Toaster position="bottom-right" />
        </QueryClientProvider>
      </WagmiProvider>
    </ThemeProvider>
  );
}
