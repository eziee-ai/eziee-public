"use client";

import Link from "next/link";
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@repo/ui/cn";
import { appChains } from "@/lib/chains";

/** The frame both transfer pages share: the Deposit/Withdraw toggle and the network choice. */
export function TransferShell({ active, chainId, onChainChange, children }: { active: "deposit" | "withdraw"; chainId: number; onChainChange: (chainId: number) => void; children: ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-[560px] flex-col gap-4 px-4 py-8">
      <h1 className="sr-only">{active === "deposit" ? "Deposit" : "Withdraw"}</h1>
      <div className="flex rounded-full bg-[color:var(--m-surface-2)] p-1">
        {(["deposit", "withdraw"] as const).map((tab) => (
          <Link
            key={tab}
            href={`/${tab}`}
            aria-current={tab === active ? "page" : undefined}
            className={cn(
              "flex min-h-11 flex-1 items-center justify-center rounded-full text-sm font-semibold capitalize",
              tab === active && "bg-[color:var(--m-background)] shadow-[0_0_0_1px_var(--m-border)]",
            )}
          >
            {tab}
          </Link>
        ))}
      </div>

      <div role="radiogroup" aria-label="Network" onKeyDown={radioGroupKeyDown} className="flex gap-2">
        {appChains.map((chain) => (
          <button
            key={chain.id}
            type="button"
            role="radio"
            aria-checked={chain.id === chainId}
            tabIndex={chain.id === chainId ? 0 : -1}
            data-testid={`network-${chain.id}`}
            onClick={() => onChainChange(chain.id)}
            className={cn(
              "min-h-11 flex-1 rounded-xl border border-[color:var(--m-border)] px-3 text-sm font-medium transition-colors hover:bg-[color:var(--m-surface)]",
              chain.id === chainId && "border-[color:var(--m-primary-fg)] bg-[color:var(--m-surface-selected)] text-[color:var(--m-on-surface-selected)]",
            )}
          >
            {chain.name}
          </button>
        ))}
      </div>

      {children}
    </main>
  );
}

export function Card({ title, children, className }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn("flex flex-col gap-3.5 rounded-2xl border border-[color:var(--m-border)] bg-[color:var(--m-surface)] p-5", className)}>
      {title && <h2 className="text-[15px] font-semibold">{title}</h2>}
      {children}
    </section>
  );
}

export function Notice({ tone, children }: { tone: "warning" | "error"; children: ReactNode }) {
  return (
    <div
      role={tone === "error" ? "alert" : "note"}
      className={cn(
        "rounded-xl border px-4 py-3 text-sm",
        tone === "warning" && "border-[color:var(--m-warning-300)] bg-[color:var(--m-warning-100)] text-[color:var(--m-warning-700)] dark:border-[color:var(--m-warning-700)] dark:bg-[color:var(--m-warning-800)] dark:text-[color:var(--m-warning-300)]",
        tone === "error" && "border-[color:var(--m-error-200)] bg-[color:var(--m-error-100)] text-[color:var(--m-error-600)] dark:border-[color:var(--m-error-700)] dark:bg-[color:var(--m-error-800)] dark:text-[color:var(--m-error-300)]",
      )}
    >
      {children}
    </div>
  );
}

/** A failed balance read must never look like an empty wallet. */
export function BalanceError({ chainName, onRetry }: { chainName: string; onRetry: () => void }) {
  return (
    <Notice tone="error">
      <span data-testid="balance-error">Balances on {chainName} could not be read, so nothing is listed. Your funds are not affected.</span>{" "}
      <button type="button" onClick={onRetry} className="min-h-11 font-semibold underline underline-offset-2">
        Try again
      </button>
    </Notice>
  );
}

/**
 * Arrow-key movement for a radiogroup built from buttons (WAI-ARIA radio pattern):
 * arrows move focus AND selection, wrapping at the ends. Put it on the group.
 */
export function radioGroupKeyDown(event: KeyboardEvent<HTMLElement>): void {
  const step = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 0;
  if (step === 0) return;
  const radios = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]:not([disabled])'));
  const at = radios.indexOf(document.activeElement as HTMLButtonElement);
  if (at < 0 || radios.length === 0) return;
  event.preventDefault();
  const next = radios[(at + step + radios.length) % radios.length]!;
  next.focus();
  next.click();
}

/** A heading that takes focus when its step appears, so a keyboard or screen-reader user is told the screen changed. */
export function StepHeading({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <h2 ref={ref} tabIndex={-1} className="text-[15px] font-semibold outline-none">
      {children}
    </h2>
  );
}
