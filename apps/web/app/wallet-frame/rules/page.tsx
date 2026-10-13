"use client";

/**
 * The wallet's own list of permission rules, served on the WALLET origin and
 * embedded by Settings → Permissions (spec §5.4). The app cannot read or change
 * rules; it can only show this frame. Revoking happens here, on a click here.
 */

import "@/lib/walletSetup";
import { protocolBrand } from "@/lib/protocols/brand";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPublicClient, erc20Abi, formatUnits, http, type Address } from "viem";
import { BRAND } from "@repo/ui/brand";
import { appOrigins } from "@repo/wallet/frame/origins";
import { event } from "@repo/wallet/frame/protocol";
import { listRules, purgeExpired, revokeRule, spentOn } from "@repo/wallet/frame/ruleStore";
import { dayKey, type Rule } from "@repo/wallet/frame/rules";
import { endSession, sessionStatus } from "@repo/wallet/frame/signer";
import { appChains } from "@/lib/chains";
import { useEmbedded } from "@/lib/useEmbedded";

interface Row {
  rule: Rule;
  spentToday: bigint;
  symbol: string | null;
  decimals: number | null;
}

function words(text: string): string {
  const spaced = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

async function tokenMeta(rule: Rule): Promise<{ symbol: string | null; decimals: number | null }> {
  const chain = appChains.find((c) => c.id === rule.chainId);
  if (rule.token === "any" || !chain) return { symbol: null, decimals: null };
  if (rule.token === "native") return { symbol: chain.nativeCurrency.symbol, decimals: chain.nativeCurrency.decimals };
  try {
    const client = createPublicClient({ chain, transport: http() });
    const [symbol, decimals] = await Promise.all([
      client.readContract({ address: rule.token as Address, abi: erc20Abi, functionName: "symbol" }),
      client.readContract({ address: rule.token as Address, abi: erc20Abi, functionName: "decimals" }),
    ]);
    return { symbol, decimals };
  } catch {
    return { symbol: null, decimals: null };
  }
}

export default function WalletRulesPage() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [account, setAccount] = useState<Address | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const embedded = useEmbedded();

  // Bumped to re-read after a revoke or an ended session.
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    const theme = new URLSearchParams(window.location.search).get("theme");
    document.documentElement.classList.toggle("dark", theme !== "light");
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const now = Date.now();
        await purgeExpired(now);
        const status = sessionStatus();
        // Only this account's rules: another passkey wallet on this device has its own.
        const mine = (await listRules()).filter((rule) => status.address !== null && rule.account.toLowerCase() === status.address.toLowerCase());
        const next = await Promise.all(mine.map(async (rule) => ({ rule, spentToday: await spentOn(rule.id, dayKey(now)), ...(await tokenMeta(rule)) })));
        if (cancelled) return;
        setAccount(status.address);
        setRows(next);
        setProblem(null);
      } catch {
        if (cancelled) return;
        setProblem("The wallet's rules could not be read on this device.");
        setRows([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [version]);

  // Tell the embedding page how tall this is, so the frame never scrolls inside the page.
  useEffect(() => {
    if (!embedded || !root.current) return;
    const report = () => {
      const height = root.current?.getBoundingClientRect().height ?? 0;
      for (const origin of appOrigins()) window.parent.postMessage(event({ event: "size", height }), origin);
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(root.current);
    return () => observer.disconnect();
  }, [embedded, rows]);

  if (!embedded) return <p className="p-4 text-sm text-[color:var(--m-text-secondary)]">This page is part of the {BRAND} wallet. It runs inside the app and has nothing to show on its own.</p>;

  const amount = (row: Row, value: bigint) => (row.decimals === null ? value.toString() : formatUnits(value, row.decimals));

  return (
    <div ref={root} className="flex flex-col gap-4 p-0.5 text-[color:var(--m-text-primary)]">
      {problem && (
        <p role="alert" className="text-[13px] text-[color:var(--m-error-fg)]">
          {problem}
        </p>
      )}
      {rows === null ? (
        <p className="text-sm text-[color:var(--m-text-secondary)]">Reading rules…</p>
      ) : !account ? (
        <p data-testid="rules-locked" className="text-sm text-[color:var(--m-text-secondary)]">
          Connect your wallet to see its rules.
        </p>
      ) : rows.length === 0 ? (
        <p data-testid="rules-empty" className="text-sm text-[color:var(--m-text-secondary)]">
          No rules yet, so every action asks first. Choose “Always allow…” on an action to make one.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-[color:var(--m-border)] rounded-xl border border-[color:var(--m-border)]">
          {rows.map((row) => (
            <li key={row.rule.id} data-testid="rule-row" className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm font-semibold">
                  {words(row.rule.action)} on {protocolBrand(row.rule.protocol).name}
                </span>
                <span className="text-[13px] text-[color:var(--m-text-secondary)]">{appChains.find((c) => c.id === row.rule.chainId)?.name ?? `Chain ${row.rule.chainId}`}</span>
                {row.rule.token === "any" ? (
                  <span className="text-[13px] text-[color:var(--m-text-secondary)]">Spends nothing</span>
                ) : (
                  <span className="font-dm-mono text-[13px]">
                    Up to {amount(row, row.rule.maxPerTx)} {row.symbol ?? row.rule.token} per transaction · {amount(row, row.spentToday)} of {amount(row, row.rule.maxPerDay)} used today
                  </span>
                )}
                <span className="text-[13px] text-[color:var(--m-text-secondary)]">
                  {row.rule.persistent ? "Kept after the session. " : "Ends with the session. "}
                  Expires {new Date(row.rule.expiresAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
                </span>
              </div>
              <button
                type="button"
                aria-label={`Revoke the rule for ${words(row.rule.action).toLowerCase()} on ${protocolBrand(row.rule.protocol).name}`}
                onClick={() => void revokeRule(row.rule.id).then(reload)}
                className="min-h-11 rounded-xl border border-[color:var(--m-border)] px-4 text-sm font-semibold hover:bg-[color:var(--m-surface-2)]"
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
      {account && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-[13px] text-[color:var(--m-text-secondary)]">Ending the session removes every rule that is not kept after it.</span>
          <button
            type="button"
            data-testid="rules-end-session"
            onClick={() => {
              endSession();
              // endSession clears rules in the background; re-read shortly after so the list reflects it.
              window.setTimeout(reload, 150);
            }}
            className="min-h-11 rounded-xl border border-[color:var(--m-error-300)] px-4 text-sm font-semibold text-[color:var(--m-error-fg)] hover:bg-[color:var(--m-surface-2)]"
          >
            End session now
          </button>
        </div>
      )}
    </div>
  );
}
