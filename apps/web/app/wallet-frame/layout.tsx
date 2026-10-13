import "@/lib/walletSetup";
import type { ReactNode } from "react";
import { satoshi, dmMono } from "@/lib/fonts";
import "../globals.css";

/**
 * A root layout for `/wallet-frame/*`, the pages served on the WALLET origin.
 *
 * Outside `[locale]` on purpose, and bare on purpose: these pages hold the key
 * (see `lib/wallet/frame`), so everything the locale layout mounts — the wagmi
 * stack, a WebSocket, analytics, the site rows, next-intl — is code that would
 * run on the origin whose whole job is to run as little code as possible. The
 * stylesheet is here because the confirm frame draws a button that has to
 * match the app's; nothing else is.
 *
 * `dynamic = "force-dynamic"` because `proxy.ts` sets a per-request CSP nonce
 * for these paths, and Next applies a nonce only when it renders the page for
 * that request. A static render would ship inline scripts the CSP then
 * blocks.
 *
 * `lang` is hardcoded: there is no locale segment to read one from, and the
 * frame renders one line of copy.
 */
export const dynamic = "force-dynamic";

export default function WalletFrameLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${satoshi.variable} ${dmMono.variable}`}>
      <body className="bg-transparent font-satoshi antialiased">{children}</body>
    </html>
  );
}
