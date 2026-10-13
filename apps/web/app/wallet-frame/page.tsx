"use client";

import "@/lib/walletSetup";
import { useEffect } from "react";
import { BRAND } from "@repo/ui/brand";
import { startWalletFrameHost } from "@repo/wallet/frame/host";

/**
 * The hidden wallet frame.
 *
 * Embedded invisibly by the app (`lib/wallet/frame/client.ts`) and driven
 * entirely over `postMessage`. It renders nothing a user is meant to see; the
 * one paragraph below is for someone who opens the URL directly and wonders
 * what it is.
 */
export default function WalletFramePage() {
  useEffect(() => startWalletFrameHost(), []);

  return (
    <p className="p-4 text-sm text-[color:var(--m-text-secondary)]">
      This page is part of the {BRAND} wallet. It runs inside the app and has nothing to show on its own.
    </p>
  );
}
