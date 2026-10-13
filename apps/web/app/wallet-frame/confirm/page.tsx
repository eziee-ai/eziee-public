"use client";

/**
 * The visible confirm frame: a button the wallet origin draws.
 *
 * Embedded by `components/Wallet/WalletConfirmFrame` in place of an ordinary
 * confirm button. The app tells it what to sign (`present`); it decodes the
 * request ITSELF, prints what it is about to do, and signs only when a person
 * clicks here. The app's own description of the request is not consulted —
 * the app is the origin this control exists to distrust.
 *
 * ## Same-origin storage with the hidden frame
 *
 * Both frames live on the wallet origin, so the session the hidden frame
 * resumes is the one this button signs with. No key crosses between them.
 *
 * ## Token facts are looked up, not taken from the app
 *
 * An ERC-20 amount needs decimals and a symbol to read as a number. Those are
 * read from the token contract over the chain's public RPC; until they arrive
 * the line says base units, which is honest if ugly. A token can lie about
 * its own symbol, but that is the token's claim and is what every explorer
 * shows too.
 */

import "@/lib/walletSetup";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPublicClient, erc20Abi, http, type Address } from "viem";
import { BRAND } from "@repo/ui/brand";
import { appChains } from "@/lib/chains";
import { appOrigins, isAllowedAppOrigin } from "@repo/wallet/frame/origins";
import { describe, describeLines, type TokenMeta } from "@repo/wallet/frame/policy";
import {
  ERR,
  event,
  isPresentParams,
  isRequestEnvelope,
  respond,
  toFrameError,
  type FrameEvent,
  type PresentParams,
} from "@repo/wallet/frame/protocol";
import { executeSigned, sessionStatus } from "@repo/wallet/frame/signer";
import type { DecodedForDisplay } from "@repo/wallet/frame/rules";
import { decodeForCard, PermissionCard, tokenKey } from "./PermissionCard";
import { useEmbedded } from "@/lib/useEmbedded";

const BUTTON: Record<Exclude<PresentParams["variant"], "card">, string> = {
  sheet:
    "w-full rounded-xl bg-[color:var(--m-primary)] px-4 py-2.5 text-[13.5px] font-bold text-[color:var(--m-on-primary)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60",
  modal:
    "h-12 w-full rounded-2xl bg-[color:var(--m-primary)] text-sm font-medium text-[color:var(--m-on-primary)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50",
};

/** What is being presented, as a string: same request, same key. Only a change of key is a change of request. */
function presentKey(params: PresentParams): string {
  return JSON.stringify([params.chainId, params.variant, params.rpc]);
}

function tokensIn(rpc: PresentParams["rpc"]): Address[] {
  if (!rpc) return [];
  const d = describe(rpc);
  const calls = d.kind === "transaction" ? [d.call] : [];
  const out = new Set<Address>();
  for (const c of calls) {
    if (c.kind === "erc20-transfer" || c.kind === "erc20-approve") out.add(c.token);
  }
  return [...out];
}

export default function WalletConfirmPage() {
  const [present, setPresent] = useState<PresentParams | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // Keyed by chain AND address (`tokenKey`): the same address can be another token on another chain.
  const [tokens, setTokens] = useState<Record<string, TokenMeta>>({});
  // The wallet's own decode of what is presented, tagged with the request it belongs to so a
  // stale answer can never be shown beside a newer request. `undefined` value = still working.
  const [decode, setDecode] = useState<{ key: string; value: DecodedForDisplay | null } | null>(null);
  // Did this request replace a DIFFERENT one that was on screen? The card says so.
  const [replaced, setReplaced] = useState(false);
  const lastKey = useRef<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  // Embedded only. Opened directly there is no parent to talk to.
  const embedded = useEmbedded();

  // Theme from the query, applied the way next-themes does it: a class on <html>.
  useEffect(() => {
    const theme = new URLSearchParams(window.location.search).get("theme");
    document.documentElement.classList.toggle("dark", theme !== "light");
  }, []);

  // The protocol: answer `present` from the one allowed origin, announce ready.
  // The origin that embedded us, learned from its first valid message and
  // replied to from then on. Several origins may be allowed; only one asked.
  const asker = useRef<string | null>(null);

  useEffect(() => {
    if (!embedded) return;
    const parent = window.parent;
    const onMessage = (e: MessageEvent) => {
      if (!isAllowedAppOrigin(e.origin) || e.source !== parent) return;
      if (!isRequestEnvelope(e.data) || e.data.method !== "present") return;
      asker.current = e.origin;
      if (!isPresentParams(e.data.params)) {
        parent.postMessage(
          { ...respond(e.data.id, undefined), error: { code: ERR.INVALID_PARAMS, message: "present needs chainId, rpc, label, disabled, variant" } },
          e.origin,
        );
        return;
      }
      const key = presentKey(e.data.params);
      // The app re-presents the SAME request freely (on every render); only a different one counts.
      if (key !== lastKey.current) {
        setReplaced(lastKey.current !== null && e.data.params.rpc !== null);
        lastKey.current = key;
      }
      setPresent(e.data.params);
      setProblem(null);
      parent.postMessage(respond(e.data.id, { ok: true }), e.origin);
    };
    window.addEventListener("message", onMessage);
    for (const origin of appOrigins()) parent.postMessage(event({ event: "ready" }), origin);
    return () => window.removeEventListener("message", onMessage);
  }, [embedded]);

  // Report our height so the app's placeholder never clips the summary line.
  useEffect(() => {
    if (!embedded || !root.current) return;
    const report = () => {
      const height = root.current?.getBoundingClientRect().height ?? 0;
      for (const origin of asker.current ? [asker.current] : appOrigins()) {
        window.parent.postMessage(event({ event: "size", height }), origin);
      }
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(root.current);
    return () => observer.disconnect();
  }, [embedded, present]);

  // Best-effort token facts for the summary line.
  useEffect(() => {
    if (!present?.rpc) return;
    const chain = appChains.find((c) => c.id === present.chainId);
    if (!chain) return;
    const chainId = present.chainId;
    const key = presentKey(present);
    // Tokens named by the raw call AND by the wallet's own decode of it, so the card can show symbols and decimals.
    const decoded = decode?.key === key ? decode.value : null;
    const named = [...(decoded?.spend ?? []).map((s) => s.token), decoded?.receive?.token].filter((t): t is Address => typeof t === "string" && t !== "native");
    const wanted = [...new Set([...tokensIn(present.rpc), ...named])].filter((t) => !tokens[tokenKey(chainId, t)]);
    if (wanted.length === 0) return;
    const client = createPublicClient({ chain, transport: http() });
    let cancelled = false;
    void Promise.all(
      wanted.map(async (token) => {
        try {
          const [symbol, decimals] = await Promise.all([
            client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }),
            client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
          ]);
          return [tokenKey(chainId, token), { symbol, decimals }] as const;
        } catch {
          return null;
        }
      }),
    ).then((rows) => {
      if (cancelled) return;
      setTokens((prev) => {
        const next = { ...prev };
        for (const row of rows) if (row) next[row[0]] = row[1];
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
    // `tokens` is deliberately not a dependency: it is what this effect fills.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [present, decode]);

  // Decode what is presented, in the frame, from the calldata (and, for Rate's swap, the chain).
  useEffect(() => {
    if (!present || present.variant !== "card") return;
    const key = presentKey(present);
    let cancelled = false;
    void decodeForCard(present.chainId, present.rpc, sessionStatus().address).then((value) => {
      if (!cancelled) setDecode({ key, value });
    });
    return () => {
      cancelled = true;
    };
  }, [present]);

  // The origin is read when the event is SENT, not while rendering: whoever presented last is who hears back.
  const report = useCallback((data: FrameEvent) => {
    window.parent.postMessage(event(data), asker.current ?? appOrigins()[0] ?? window.location.origin);
  }, []);

  const confirm = useCallback(async () => {
    if (!present?.rpc || busy) return;
    setBusy(true);
    setProblem(null);
    const allowed = asker.current ?? appOrigins()[0] ?? window.location.origin;
    try {
      const hash = await executeSigned(present.chainId, present.rpc);
      window.parent.postMessage(event({ event: "submitted", hash }), allowed);
    } catch (err) {
      const error = toFrameError(err);
      setProblem(
        error.code === ERR.LOCKED
          ? "Your passkey session has expired. Sign in again to continue."
          : error.code === ERR.USER_REJECTED
            ? null
            : error.message,
      );
      window.parent.postMessage(event({ event: "failed", error }), allowed);
    } finally {
      setBusy(false);
    }
  }, [present, busy]);

  if (!embedded) {
    return (
      <p className="p-4 text-sm text-[color:var(--m-text-secondary)]">
        This page is part of the {BRAND} wallet. It runs inside the app and has nothing to show on its own.
      </p>
    );
  }

  if (present?.variant === "card") {
    const key = presentKey(present);
    return (
      <div ref={root}>
        <PermissionCard
          // A different request is a different card: editor closed, limits cleared, buttons dead for a beat.
          key={key}
          chainId={present.chainId}
          rpc={present.rpc}
          decoded={decode?.key === key ? decode.value : undefined}
          disabled={present.disabled}
          replaced={replaced}
          tokens={tokens}
          onSubmitted={(hash) => report({ event: "submitted", hash })}
          onFailed={(error) => report({ event: "failed", error })}
        />
      </div>
    );
  }

  const variant = present?.variant ?? "sheet";
  // describeLines looks tokens up by bare lowercase address; keep only this chain's.
  const chainTokens = Object.fromEntries(Object.entries(tokens).filter(([k]) => k.startsWith(`${present?.chainId}:`)).map(([k, v]) => [k.split(":")[1]!, v]));
  const lines = present?.rpc ? describeLines(present.chainId, describe(present.rpc), chainTokens) : [];

  return (
    <div ref={root} className="flex flex-col gap-1.5">
      {lines.length > 0 && (
        <ul className="flex flex-col gap-0.5 px-0.5">
          {lines.map((line) => (
            <li key={line} className="font-dm-mono text-[11px] leading-4 text-[color:var(--m-text-secondary)]">
              {line}
            </li>
          ))}
        </ul>
      )}
      {problem && <p className="px-0.5 text-[11.5px] leading-4 text-[color:var(--m-error-fg)]">{problem}</p>}
      <button
        type="button"
        disabled={!present || present.disabled || !present.rpc || busy}
        onClick={() => void confirm()}
        className={BUTTON[variant]}
      >
        {busy ? `${present?.label ?? "Confirm"}…` : (present?.label ?? "Confirm")}
      </button>
    </div>
  );
}
