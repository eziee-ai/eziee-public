import type { Metadata } from "next";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import { BRAND, BRAND_DESCRIPTION } from "@repo/ui/brand";
import { AppShell } from "@/components/shell/AppShell";
import { ConnectWalletDialog } from "@/components/wallet/ConnectWalletDialog";
import { dmMono, satoshi } from "@/lib/fonts";
import { ENFORCED_META_CSP } from "@/lib/security/csp";
import { Providers } from "@/lib/providers";
import "../globals.css";

export const metadata: Metadata = { title: BRAND, description: BRAND_DESCRIPTION };

// The proxy sets a per-request CSP nonce, and Next applies a nonce only when it
// renders the page for that request. A static render would ship scripts without it.
export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: ReactNode }) {
  // proxy.ts puts this request's nonce on the request headers as `x-nonce`.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="en" suppressHydrationWarning className={`${satoshi.variable} ${dmMono.variable}`}>
      {/* Enforced as a <meta> tag, not a header: a next.config.ts headers()
          entry named Content-Security-Policy is also applied to the request
          and shadows the per-request nonce Next reads to tag its own scripts.
          See lib/security/csp.ts. */}
      <head>
        <meta httpEquiv="Content-Security-Policy" content={ENFORCED_META_CSP} />
      </head>
      <body className="font-satoshi antialiased">
        <Providers nonce={nonce}>
          <AppShell>{children}</AppShell>
          {/* Mounted once for every app route, so requestWalletConnect() always has a listener. */}
          <ConnectWalletDialog />
        </Providers>
      </body>
    </html>
  );
}
