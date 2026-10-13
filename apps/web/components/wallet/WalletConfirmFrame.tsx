"use client";

/**
 * The confirm button for a value-moving request, drawn by the WALLET origin.
 *
 * A withdrawal is signed by the passkey session with no prompt — the same
 * session that signs trades. What makes that safe against script on this
 * origin is that the click has to land somewhere that script cannot fake:
 * this iframe, served from `<walletOrigin>/wallet-frame/confirm`, which
 * decodes the request itself, prints a one-line restatement of what it will
 * do above the button, and signs only on a real click inside it. A synthetic
 * event on this document cannot reach a cross-origin frame, and the frame's
 * policy (`lib/wallet/frame/policy.ts`) is what refuses the same request on
 * the hidden path.
 *
 * ## Drop-in for the button it replaces
 *
 * Same label, same spot, one click. The caller passes the request it would
 * have sent through wagmi, the label its button carried, and gets the hash
 * back through `onSubmitted` — from there the flow is unchanged. Until the
 * frame reports ready a disabled button with the same label holds the space,
 * so nothing shifts.
 *
 * ## What the caller does NOT get
 *
 * A promise. The frame's click is the frame's; the caller learns the outcome
 * through the two callbacks. A `LOCKED` failure means the session expired
 * between the preview and the click — the caller offers "sign in again", as
 * the withdraw sheet already does.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "next-themes";
import type { Hex } from "viem";
import { cn } from "@repo/ui/cn";
import { CONFIRM_PATH, walletOrigin } from "@repo/wallet/frame/origins";
import {
  isEventEnvelope,
  request as makeRequest,
  WalletFrameError,
  type PresentParams,
  type WalletRpc,
} from "@repo/wallet/frame/protocol";

export interface WalletConfirmFrameProps {
  chainId: number;
  /** Null while nothing is ready to sign; the button renders inert. */
  rpc: WalletRpc | null;
  label: string;
  disabled?: boolean;
  variant?: PresentParams["variant"];
  onSubmitted: (hash: Hex) => void;
  onFailed: (error: WalletFrameError) => void;
  className?: string;
}

/** The two button shapes the app uses, so the placeholder matches the frame's. */
const BUTTON: Record<PresentParams["variant"], string> = {
  sheet:
    "w-full rounded-xl bg-[color:var(--m-primary)] px-4 py-2.5 text-[13.5px] font-bold text-[color:var(--m-on-primary)] disabled:cursor-not-allowed disabled:opacity-60",
  modal:
    "h-12 w-full rounded-2xl bg-[color:var(--m-primary)] text-sm font-medium text-[color:var(--m-on-primary)] disabled:cursor-not-allowed disabled:opacity-50",
  // The card draws its own three buttons; this is only the placeholder shown until the frame is ready.
  card: "h-11 w-full rounded-xl bg-[color:var(--m-surface-2)] text-sm font-medium text-[color:var(--m-text-secondary)] disabled:cursor-not-allowed",
};

const INITIAL_HEIGHT: Record<PresentParams["variant"], number> = { sheet: 42, modal: 48, card: 168 };

export function WalletConfirmFrame({
  chainId,
  rpc,
  label,
  disabled = false,
  variant = "sheet",
  onSubmitted,
  onFailed,
  className,
}: WalletConfirmFrameProps) {
  const { resolvedTheme } = useTheme();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [height, setHeight] = useState(INITIAL_HEIGHT[variant]);

  // Theme is read once: a frame reload on toggle would drop a request mid-flight.
  const src = useMemo(() => {
    const theme = resolvedTheme === "light" ? "light" : "dark";
    return `${walletOrigin()}${CONFIRM_PATH}?theme=${theme}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const origin = walletOrigin();
    const onMessage = (e: MessageEvent) => {
      const frame = frameRef.current;
      if (!frame || e.origin !== origin || e.source !== frame.contentWindow) return;
      if (!isEventEnvelope(e.data)) return;
      const data = e.data.data;
      switch (data.event) {
        case "ready":
          setReady(true);
          break;
        case "size":
          if (Number.isFinite(data.height) && data.height > 0) setHeight(Math.ceil(data.height));
          break;
        case "submitted":
          onSubmitted(data.hash);
          break;
        case "failed":
          onFailed(new WalletFrameError(data.error));
          break;
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
    // Re-subscribed when a callback changes, so a message always reaches the
    // callbacks of the latest commit. A ref written in an effect left a window
    // where the previous commit's callbacks still answered.
  }, [onSubmitted, onFailed]);

  // Re-present on every change: the frame renders what it was last told.
  useEffect(() => {
    if (!ready) return;
    const target = frameRef.current?.contentWindow;
    if (!target) return;
    const params: PresentParams = { chainId, rpc, label, disabled: disabled || rpc === null, variant };
    target.postMessage(makeRequest(crypto.randomUUID(), "present", params), walletOrigin());
  }, [ready, chainId, rpc, label, disabled, variant]);

  return (
    <div className={cn("relative w-full", className)} style={{ minHeight: height }}>
      {!ready && (
        <button type="button" disabled className={cn(BUTTON[variant], "absolute inset-x-0 top-0")}>
          {label}
        </button>
      )}
      <iframe
        ref={frameRef}
        src={src}
        title={label}
        className={cn("block w-full border-0 bg-transparent", !ready && "opacity-0")}
        style={{ height }}
      />
    </div>
  );
}
