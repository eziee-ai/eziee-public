"use client";

import Link from "next/link";
import { ArrowRight, Fingerprint, ShieldCheck } from "lucide-react";
import { useEffect } from "react";
import { BRAND } from "@repo/ui/brand";
import { useWalletAccount, useWalletConnect } from "@repo/wallet";
import { useRouter, useSearchParams } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const next = safeNext(useSearchParams().get("next"));
  const { isConnected } = useWalletAccount();
  const { open, ready } = useWalletConnect();

  useEffect(() => {
    if (isConnected) router.replace(next);
  }, [isConnected, next, router]);

  return (
    <main className="grid min-h-dvh place-items-center bg-[color:var(--m-ground)] px-5 py-10 text-[color:var(--m-text-primary)]">
      <div className="w-full max-w-[430px]">
        <Link href="/" aria-label={`${BRAND} home`} className="mb-10 flex items-center justify-center gap-2 text-xl font-black italic tracking-[-0.08em]">
          <span className="relative grid h-9 w-9 place-items-center rounded-xl bg-[color:var(--m-primary)] text-lg not-italic text-[color:var(--m-on-primary)]"><span>e</span><span className="absolute right-1 top-0 text-[9px] leading-none">✦</span></span>
          {BRAND}
        </Link>

        <section className="rounded-[28px] border border-[color:var(--m-border)] bg-[color:var(--m-surface)] p-7 shadow-[0_24px_80px_rgba(0,0,0,0.08)] sm:p-9" aria-labelledby="login-title">
          <p className="font-dm-mono text-[10px] uppercase tracking-[0.2em] text-[color:var(--m-primary-fg)]">Invite-only access</p>
          <h1 id="login-title" className="mt-4 text-4xl font-black leading-[0.98] tracking-[-0.06em]">Welcome back.</h1>
          <p className="mt-4 text-[15px] leading-7 text-[color:var(--m-text-secondary)]">Already have an invite? Sign in with the passkey wallet on this device.</p>

          <button type="button" data-testid="login-passkey" disabled={!ready} onClick={open} className="mt-8 flex min-h-14 w-full items-center justify-between rounded-2xl bg-[color:var(--m-primary)] px-5 text-left font-bold text-[color:var(--m-on-primary)] transition-transform hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-60">
            <span className="flex items-center gap-3"><Fingerprint aria-hidden className="h-5 w-5" />Sign in with passkey</span>
            <ArrowRight aria-hidden className="h-5 w-5" />
          </button>

          <div className="mt-7 flex items-start gap-3 border-t border-[color:var(--m-border)] pt-6 text-[12px] leading-5 text-[color:var(--m-text-secondary)]">
            <ShieldCheck aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--m-primary-fg)]" />
            <span>Your wallet stays on this device. Face ID or your fingerprint approves each action.</span>
          </div>
        </section>

        <p className="mt-6 text-center text-[13px] text-[color:var(--m-text-secondary)]">Need an invite? <Link href="/#waitlist" className="font-semibold text-[color:var(--m-text-primary)] underline decoration-[color:var(--m-primary-fg)] underline-offset-4">Request access</Link></p>
      </div>
    </main>
  );
}

/** Where to go after signing in: only the chat pages the sign-in gate sends from, so `next` can never leave the app. */
function safeNext(value: string | null): string {
  return value && /^\/(home|c\/[0-9a-f-]{36})$/.test(value) ? value : "/home";
}
