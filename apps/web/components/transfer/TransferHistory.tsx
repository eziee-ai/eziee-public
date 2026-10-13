"use client";

import { useSyncExternalStore } from "react";
import { appChains } from "@/lib/chains";
import { forChain, subscribeTransfers, transfersServerSnapshot, transfersSnapshot } from "@/lib/transfer/history";

/** Receipts recorded on this device. Nothing here comes from a server. */
export function TransferHistory({ chainId }: { chainId: number }) {
  const log = useSyncExternalStore(subscribeTransfers, transfersSnapshot, transfersServerSnapshot);
  const rows = forChain(log, chainId).slice(0, 8);
  const explorer = appChains.find((c) => c.id === chainId)?.blockExplorers?.default.url.replace(/\/$/, "");
  if (rows.length === 0) return null;

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold text-[color:var(--m-text-secondary)]">Recent on this device</h2>
      <ul className="flex flex-col divide-y divide-[color:var(--m-border)] rounded-2xl border border-[color:var(--m-border)]">
        {rows.map((row) => (
          <li key={row.hash} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
            <span className="flex flex-col">
              <span className="font-medium capitalize">{row.kind}</span>
              <span className="text-xs text-[color:var(--m-text-secondary)]">{new Date(row.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</span>
            </span>
            <span className="flex items-center gap-3">
              <span className="font-dm-mono">
                {row.kind === "withdraw" ? "-" : "+"}
                {row.amount} {row.symbol}
              </span>
              {explorer && (
                <a href={`${explorer}/tx/${row.hash}`} target="_blank" rel="noreferrer" className="flex min-h-11 items-center text-[color:var(--m-primary-fg)] underline underline-offset-2">
                  View
                </a>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
