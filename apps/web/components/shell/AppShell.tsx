"use client";

import { Menu, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useWalletAccount } from "@repo/wallet";
import { BRAND } from "@repo/ui/brand";
import { useModalFocus } from "@/lib/useModalFocus";
import { Sidebar } from "./Sidebar";

/** Sidebar beside the page on wide screens; a drawer behind a menu button on narrow ones. */
export function AppShell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const drawer = useModalFocus<HTMLDivElement>(open, () => setOpen(false));
  const router = useRouter();
  const { isConnected, isLoading } = useWalletAccount();
  // The chat needs a wallet: signed out, it is replaced by the sign-in page, which comes back here after.
  const gated = isChatPath(pathname) && !isConnected;
  useEffect(() => {
    if (gated && !isLoading) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [gated, isLoading, pathname, router]);
  // Sign-in stands on its own page, with no sidebar. Every hook above runs first, unconditionally.
  if (pathname === "/login") return <>{children}</>;
  if (gated) return null;
  return (
    <div className="flex h-dvh">
      <aside className="hidden md:block">
        <Sidebar />
      </aside>

      {open && (
        <div ref={drawer} className="fixed inset-0 z-40 flex md:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <Sidebar onNavigate={() => setOpen(false)} />
          <button type="button" aria-label="Close menu" onClick={() => setOpen(false)} className="grid flex-1 place-items-start justify-end bg-black/45 p-3">
            <span className="grid h-11 w-11 place-items-center rounded-xl bg-[color:var(--m-surface)]">
              <X aria-hidden className="h-5 w-5" />
            </span>
          </button>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-[color:var(--m-border)] px-2 md:hidden">
          <button type="button" aria-label="Open menu" onClick={() => setOpen(true)} className="grid h-11 w-11 place-items-center rounded-xl hover:bg-[color:var(--m-surface-2)]">
            <Menu aria-hidden className="h-5 w-5" />
          </button>
          <span className="flex items-center gap-1.5 text-[15px] font-black italic tracking-tight"><span className="relative grid h-6 w-6 shrink-0 place-items-center overflow-hidden rounded bg-[color:var(--m-logo-ground)] text-[13px] not-italic leading-none text-[color:var(--m-logo)]"><span className="-translate-x-px translate-y-px italic">e</span><span className="absolute right-0.5 top-0 text-[7px] leading-none text-[color:var(--m-primary-fg)]">✦</span></span>{BRAND}</span>
        </header>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

/** The agent's pages: a new chat and a saved one. */
function isChatPath(pathname: string): boolean {
  return pathname === "/home" || pathname.startsWith("/c/");
}
