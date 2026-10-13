"use client";

import { formatUnits } from "viem";
import { cn } from "@repo/ui/cn";
import type { TransferAsset } from "@/lib/transfer/withdrawForm";
import { radioGroupKeyDown } from "./TransferShell";

export function assetKey(asset: TransferAsset): string {
  return `${asset.chainId}:${asset.token}`;
}

export function AssetList({ assets, selected, onSelect, isLoading }: { assets: TransferAsset[]; selected: string | null; onSelect: (asset: TransferAsset) => void; isLoading: boolean }) {
  if (isLoading && assets.length === 0) {
    return (
      <div aria-busy="true" className="flex flex-col gap-2">
        {[0, 1].map((i) => (
          <div key={i} className="h-14 animate-pulse rounded-xl bg-[color:var(--m-surface-2)]" />
        ))}
      </div>
    );
  }
  return (
    <div role="radiogroup" aria-label="Asset" onKeyDown={radioGroupKeyDown} className="flex flex-col gap-2">
      {assets.map((asset, index) => {
        const key = assetKey(asset);
        const on = key === selected;
        return (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={on}
            // Roving tabindex: the chosen row is the group's one tab stop, or the first when none is chosen.
            tabIndex={on || (selected === null && index === 0) ? 0 : -1}
            data-testid={`asset-${asset.symbol}`}
            onClick={() => onSelect(asset)}
            className={cn(
              "flex min-h-14 items-center justify-between gap-3 rounded-xl border border-[color:var(--m-border)] px-3.5 text-left transition-colors hover:bg-[color:var(--m-surface-2)]",
              on && "border-[color:var(--m-primary-fg)] bg-[color:var(--m-surface-selected)] text-[color:var(--m-on-surface-selected)]",
            )}
          >
            <span className="flex flex-col">
              <span className="flex items-center gap-2 text-sm font-semibold">
                {asset.symbol}
                {asset.trust === "unreviewed" && <UnreviewedPill />}
              </span>
              <span className="text-xs text-[color:var(--m-text-secondary)]">{asset.name}</span>
            </span>
            <span className="min-w-0 truncate font-dm-mono text-sm">{formatUnits(asset.held, asset.decimals)}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Marks a token the person added by address. It is not on the reviewed list, and the assistant never trades it. */
export function UnreviewedPill() {
  return <span className="rounded-full border border-[color:var(--m-border)] px-2 py-0.5 text-[11px] font-medium text-[color:var(--m-text-secondary)]">Unreviewed</span>;
}
