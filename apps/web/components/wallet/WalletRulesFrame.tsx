"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { walletOrigin } from "@repo/wallet/frame/origins";
import { isEventEnvelope } from "@repo/wallet/frame/protocol";

const RULES_PATH = "/wallet-frame/rules";

/**
 * The wallet's rule list, embedded from the wallet origin. The app never sees
 * the rules themselves; it only learns how tall the frame wants to be.
 */
export function WalletRulesFrame() {
  const { resolvedTheme } = useTheme();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(96);

  // Theme is read once, as in WalletConfirmFrame: reloading the frame on toggle would drop its state.
  const src = useMemo(() => {
    const theme = resolvedTheme === "light" ? "light" : "dark";
    return `${walletOrigin()}${RULES_PATH}?theme=${theme}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const origin = walletOrigin();
    const onMessage = (e: MessageEvent) => {
      const frame = frameRef.current;
      if (!frame || e.origin !== origin || e.source !== frame.contentWindow) return;
      if (!isEventEnvelope(e.data)) return;
      const data = e.data.data;
      if (data.event === "size" && Number.isFinite(data.height) && data.height > 0) setHeight(Math.ceil(data.height));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return <iframe ref={frameRef} src={src} title="Wallet permission rules" data-testid="wallet-rules-frame" className="w-full border-0 bg-transparent" style={{ height }} />;
}
