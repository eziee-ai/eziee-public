"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ArrowDownToLine, ArrowUpFromLine, Coins, Moon, Plus, Search, ShieldCheck, SlidersHorizontal, Sun, Wallet } from "lucide-react";
import Link from "next/link";
import { useTheme } from "next-themes";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { formatUsd } from "@repo/agent/pricing";
import { BRAND } from "@repo/ui/brand";
import { cn } from "@repo/ui/cn";
import { ChatHistory, type ChatRow } from "@/components/shell/ChatHistory";
import { WalletStatus } from "@/components/wallet/WalletStatus";
import { startNewChat } from "@/lib/chat/newChat";
import { useDebounced } from "@/lib/useDebounced";
import { useAppSession } from "@/lib/session/useAppSession";


const NAV = [
  { href: "/deposit", label: "Deposit", icon: ArrowDownToLine },
  { href: "/withdraw", label: "Withdraw", icon: ArrowUpFromLine },
  { href: "/tokens", label: "Tokens", icon: Coins },
  { href: "/settings/credit", label: "Credit", icon: Wallet },
  { href: "/settings/permissions", label: "Permissions", icon: ShieldCheck },
] as const;

const ROW = "flex min-h-11 items-center gap-2.5 rounded-xl px-3 text-sm transition-colors hover:bg-[color:var(--m-surface-2)]";
const ROW_ON = "bg-[color:var(--m-surface-selected)] font-semibold text-[color:var(--m-on-surface-selected)]";

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const { resolvedTheme, setTheme } = useTheme();
  const session = useAppSession();
  const [query, setQuery] = useState("");

  // One request per pause in typing, and the previous results stay up while the next ones load.
  const search = useDebounced(query.trim(), 250);
  const chats = useQuery({
    queryKey: ["chats", session.address ?? null, search],
    enabled: session.signedIn,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const response = await fetch(`/api/chats${search ? `?q=${encodeURIComponent(search)}` : ""}`, { cache: "no-store" });
      if (!response.ok) throw new Error("chats");
      return ((await response.json()) as { chats: ChatRow[] }).chats;
    },
  });

  // On a short screen the column scrolls, rather than squeezing the chat list to nothing.
  return (
    <div className="flex h-full w-[280px] flex-col gap-3 overflow-y-auto border-r border-[color:var(--m-border)] bg-[color:var(--m-surface)] p-4">
      <Link href="/home" onClick={onNavigate} className="flex min-h-11 items-center gap-2.5 text-[17px] font-bold tracking-tight">
        {/* The glyph carries the visual identity; the wordmark is the only text label. */}
        <span aria-hidden className="relative grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-lg bg-[color:var(--m-primary)] font-black italic text-[19px] leading-none text-[color:var(--m-on-primary)]"><span className="-translate-x-px translate-y-px">e</span><span className="absolute right-1 top-0 text-[9px] leading-none text-[color:var(--m-on-primary)]">✦</span></span>
        <span className="font-black italic tracking-[-0.08em]">{BRAND}</span>
      </Link>

      <Link href="/home" onClick={() => (startNewChat(), onNavigate?.())} data-testid="new-chat" className="flex min-h-11 items-center gap-2 rounded-xl border border-[color:var(--m-border)] px-3 text-sm font-semibold hover:bg-[color:var(--m-surface-2)]">
        <Plus aria-hidden className="h-[18px] w-[18px]" /> New chat
      </Link>

      <div className="relative">
        <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[color:var(--m-text-secondary)]" />
        <label htmlFor="chat-search" className="sr-only">
          Search chats
        </label>
        <input id="chat-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search chats" className="h-11 w-full rounded-xl border border-[color:var(--m-border)] bg-transparent pl-9 pr-3 text-sm" />
      </div>

      <nav aria-label="Chat history" className="flex min-h-[18rem] flex-1 flex-col gap-0.5 overflow-y-auto">
        {!session.signedIn ? (
          <p className="px-3 py-2 text-[13px] text-[color:var(--m-text-secondary)]">Your chats are stored under your wallet address and appear here after you connect.</p>
        ) : chats.isError ? (
          <p role="alert" className="px-3 py-2 text-[13px] text-[color:var(--m-error-fg)]">
            Your chats could not be loaded.
          </p>
        ) : chats.isPending ? (
          <p className="px-3 py-2 text-[13px] text-[color:var(--m-text-secondary)]">Loading your chats…</p>
        ) : search && (chats.data ?? []).length === 0 ? (
          <p className="px-3 py-2 text-[13px] text-[color:var(--m-text-secondary)]">No chat matches that.</p>
        ) : (
          <ChatHistory chats={chats.data ?? []} searching={search !== ""} pathname={pathname} onNavigate={onNavigate} />
        )}
      </nav>

      <nav aria-label="Main" className="flex flex-col gap-0.5">
        {[...NAV, ...(session.admin ? [{ href: "/admin", label: "Admin", icon: SlidersHorizontal }] : [])].map(({ href, label, icon: Icon }) => (
          <Link key={href} href={href} onClick={onNavigate} aria-current={pathname.startsWith(href) ? "page" : undefined} className={cn(ROW, "font-medium", pathname.startsWith(href) && ROW_ON)}>
            <Icon aria-hidden className="h-[18px] w-[18px]" /> {label}
          </Link>
        ))}
      </nav>

      {session.credit && (
        <div className="flex items-center justify-between rounded-xl border border-[color:var(--m-border)] px-3 py-2.5">
          <span className="flex flex-col">
            <span className="text-xs text-[color:var(--m-text-secondary)]">Credit</span>
            <span data-testid="credit-balance" className="font-dm-mono text-base">
              {formatUsd(BigInt(session.credit.spendableMicrousd))}
            </span>
            {BigInt(session.credit.heldMicrousd) > 0n && (
              <span data-testid="credit-held" className="text-xs text-[color:var(--m-text-secondary)]">
                {formatUsd(BigInt(session.credit.heldMicrousd))} on hold
              </span>
            )}
          </span>
          {session.credit.blocked && <span className="text-xs font-semibold text-[color:var(--m-error-fg)]">Blocked</span>}
          <Link href="/settings/credit" onClick={onNavigate} data-testid="credit-link" className="flex min-h-11 items-center rounded-lg px-2 text-[13px] font-semibold text-[color:var(--m-primary-fg)] underline underline-offset-2">
            Add credit
          </Link>
        </div>
      )}

      <button type="button" aria-label="Toggle color theme" onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")} className={cn(ROW, "text-[color:var(--m-text-secondary)]")}>
        <Sun aria-hidden className="hidden h-[18px] w-[18px] dark:block" />
        <Moon aria-hidden className="h-[18px] w-[18px] dark:hidden" />
        <span className="hidden dark:inline">Light appearance</span>
        <span className="dark:hidden">Dark appearance</span>
      </button>
      <WalletStatus />
    </div>
  );
}
