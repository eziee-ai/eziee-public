"use client";

import { X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { formatUsd } from "@repo/agent/pricing";
import { cn } from "@repo/ui/cn";
import { formatTokens, type ChatUsage } from "@/lib/chat/usage";
import { useModalFocus } from "@/lib/useModalFocus";

const ROW = "flex items-center justify-between gap-4 py-1.5 text-[13px]";
const LABEL = "text-[color:var(--m-text-secondary)]";
const VALUE = "font-dm-mono";

/**
 * What this chat has used, beside the prompt. The numbers are the server's: each reply's metadata says what it
 * used and cost, and what its prompt held against the model's window (lib/chat/usage.ts).
 */
export function UsageChip({ usage, trimmed }: { usage: ChatUsage; /** How many of the oldest messages the latest reply was sent without. */ trimmed: number }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const panel = useModalFocus<HTMLDivElement>(open, () => setOpen(false));
  const titleId = useId();
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  const last = usage.last;
  const share = last ? Math.min(100, (last.contextTokens / last.contextWindow) * 100) : 0;

  return (
    <div ref={root} className="relative">
      <button type="button" data-testid="usage-chip" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={() => setOpen((v) => !v)} className={cn("flex h-9 items-center whitespace-nowrap rounded-full px-3 text-[13px] text-[color:var(--m-text-secondary)] transition-colors hover:bg-[color:var(--m-surface-2)] hover:text-[color:var(--m-text-primary)]", open && "bg-[color:var(--m-surface-2)] text-[color:var(--m-text-primary)]")}>
        {formatTokens(usage.tokens)} tokens · {formatUsd(usage.costMicrousd)}
      </button>
      {open && (
        <div ref={panel} id={panelId} role="dialog" aria-labelledby={titleId} className="absolute bottom-[calc(100%+8px)] left-0 z-20 flex w-[min(320px,calc(100vw-2rem))] flex-col rounded-2xl border border-[color:var(--m-border)] bg-[color:var(--m-surface)] p-3 shadow-xl">
          <div className="flex items-center justify-between pb-1">
            <span id={titleId} className="text-[13px] font-semibold">
              Usage in this chat
            </span>
            <button type="button" aria-label="Close" onClick={() => setOpen(false)} className="grid h-9 w-9 place-items-center rounded-lg hover:bg-[color:var(--m-surface-2)]">
              <X aria-hidden className="h-4 w-4" />
            </button>
          </div>
          <div className={ROW}>
            <span className={LABEL}>Tokens</span>
            <span className={VALUE}>{formatTokens(usage.tokens)}</span>
          </div>
          <div className={ROW}>
            <span className={LABEL}>Cost</span>
            <span className={VALUE}>{formatUsd(usage.costMicrousd)}</span>
          </div>
          <div className={ROW}>
            <span className={LABEL}>Replies</span>
            <span data-testid="usage-replies" className={VALUE}>
              {usage.replies}
            </span>
          </div>
          {last && (
            <div className="flex flex-col gap-1.5 py-1.5">
              <div className="flex items-center justify-between gap-4 text-[13px]">
                <span className={LABEL}>Context on the last reply</span>
                <span data-testid="usage-context" className={VALUE}>
                  {formatTokens(last.contextTokens)} of {formatTokens(last.contextWindow)}
                </span>
              </div>
              <div aria-hidden className="h-1 overflow-hidden rounded-full bg-[color:var(--m-surface-2)]">
                <div className="h-full rounded-full bg-[color:var(--m-primary)]" style={{ width: `${share}%` }} />
              </div>
            </div>
          )}
          {trimmed > 0 && (
            <p className="pt-1.5 text-xs leading-relaxed text-[color:var(--m-text-secondary)]">
              The first {trimmed} messages are no longer sent to the model. They stay in this chat.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
