"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { usePublicClient } from "wagmi";
import type { Hex } from "viem";
import { cn } from "@repo/ui/cn";
import { appChains } from "@/lib/chains";

/** A sent transfer: confirming, confirmed or reverted, with the full hash and an explorer link. */
export function TransferResult({ hash, chainId, summary, onDone, onReverted }: { hash: Hex; chainId: number; summary: string; onDone: () => void; onReverted?: (hash: Hex) => void }) {
  // viem's wait, not wagmi's hook: the hook THROWS on a reverted receipt, which would leave
  // this card saying "Confirming" forever about a transaction that has already failed.
  const client = usePublicClient({ chainId });
  const receipt = useQuery({
    queryKey: ["transfer-receipt", chainId, hash],
    enabled: Boolean(client),
    staleTime: Infinity,
    retry: 2,
    queryFn: () => client!.waitForTransactionReceipt({ hash }),
  });
  const explorer = appChains.find((c) => c.id === chainId)?.blockExplorers?.default.url.replace(/\/$/, "");

  const state = receipt.data ? (receipt.data.status === "success" ? "confirmed" : "reverted") : receipt.isError ? "unknown" : "confirming";
  const label = { confirming: "Confirming", confirmed: "Confirmed", reverted: "Reverted", unknown: "Not confirmed yet" }[state];

  // A reverted transfer moved nothing: let the owner take it out of the local receipts.
  useEffect(() => {
    if (state === "reverted") onReverted?.(hash);
  }, [state, hash, onReverted]);

  return (
    <section data-testid="transfer-result" data-state={state} className="flex flex-col gap-3.5 rounded-2xl border border-[color:var(--m-border)] bg-[color:var(--m-surface)] p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[15px] font-semibold">{summary}</h2>
        <span
          role="status"
          className={cn(
            "rounded-full px-2.5 py-1 text-xs font-semibold",
            state === "confirming" && "bg-[color:var(--m-surface-selected)] text-[color:var(--m-on-surface-selected)]",
            state === "confirmed" && "bg-[color:var(--m-surface-success)] text-[color:var(--m-on-surface-success)]",
            state === "unknown" && "bg-[color:var(--m-warning-100)] text-[color:var(--m-warning-700)] dark:bg-[color:var(--m-warning-800)] dark:text-[color:var(--m-warning-300)]",
            state === "reverted" && "bg-[color:var(--m-error-100)] text-[color:var(--m-error-600)] dark:bg-[color:var(--m-error-800)] dark:text-[color:var(--m-error-300)]",
          )}
        >
          {label}
        </span>
      </div>
      {state === "reverted" && <p className="text-sm text-[color:var(--m-text-secondary)]">The transaction reverted onchain. Nothing was sent. Only the network fee was spent.</p>}
      {state === "unknown" && <p className="text-sm text-[color:var(--m-text-secondary)]">The network did not confirm this in time. It may still complete. Check the explorer before sending again.</p>}
      <div className="flex flex-col gap-1">
        <span className="text-xs text-[color:var(--m-text-secondary)]">Transaction</span>
        <code data-testid="transfer-hash" className="break-all font-dm-mono text-[13px]">
          {hash}
        </code>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        {explorer ? (
          <a href={`${explorer}/tx/${hash}`} target="_blank" rel="noreferrer" className="flex min-h-11 items-center text-sm font-medium text-[color:var(--m-primary-fg)] underline underline-offset-2">
            View on explorer
          </a>
        ) : (
          <span />
        )}
        {state === "unknown" && (
          <button type="button" onClick={() => void receipt.refetch()} className="min-h-11 rounded-xl border border-[color:var(--m-border)] px-4 text-sm font-semibold hover:bg-[color:var(--m-surface-2)]">
            Check again
          </button>
        )}
        <button type="button" onClick={onDone} className="min-h-11 rounded-xl border border-[color:var(--m-border)] px-4 text-sm font-semibold hover:bg-[color:var(--m-surface-2)]">
          Done
        </button>
      </div>
    </section>
  );
}
