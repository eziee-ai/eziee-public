"use client";

import { useEffect, useState } from "react";
import { useWalletAccount, useWalletConnect } from "@repo/wallet";
import { walletFrame } from "@repo/wallet/frame/client";

function formatExpiry(expiresAt: number | null): string {
  if (!expiresAt) return "";
  return new Date(expiresAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function WalletStatus() {
  const { address, isConnected, isLoading } = useWalletAccount();
  const { open, disconnect, ready } = useWalletConnect();
  // Keyed by address so a stale answer for a previous account is never shown,
  // and so locking the wallet needs no reset: the value is derived below.
  const [session, setSession] = useState<{ address: string; expiresAt: number | null } | null>(null);

  useEffect(() => {
    if (!isConnected || !address) return;
    let cancelled = false;
    // status() never decrypts: it reports the address and absolute expiry only.
    walletFrame
      .status()
      .then((s) => {
        if (!cancelled) setSession({ address, expiresAt: s.expiresAt ?? null });
      })
      .catch(() => {
        if (!cancelled) setSession({ address, expiresAt: null });
      });
    return () => {
      cancelled = true;
    };
  }, [isConnected, address]);

  const expiresAt = isConnected && session && session.address === address ? session.expiresAt : null;

  if (!isConnected || !address) {
    return (
      <button
        type="button"
        data-testid="connect-button"
        disabled={!ready || isLoading}
        onClick={open}
        className="min-h-11 rounded-xl bg-[color:var(--m-primary)] px-5 text-sm font-medium text-[color:var(--m-on-primary)] transition-colors hover:bg-[color:var(--m-primary-hover)] disabled:opacity-60"
      >
        {isLoading ? "Connecting…" : "Continue with passkey"}
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-[color:var(--m-border)] bg-[color:var(--m-surface)] p-5">
      <span className="text-xs uppercase tracking-wide text-[color:var(--m-text-secondary)]">Your wallet</span>
      {/* Full address on purpose: a shortened one is not safe to copy funds to. */}
      <code data-testid="wallet-address" className="break-all font-dm-mono text-sm">
        {address}
      </code>
      <span data-testid="wallet-expiry" className="font-dm-mono text-xs text-[color:var(--m-text-secondary)]">
        {expiresAt ? `Session ends ${formatExpiry(expiresAt)}` : "Session active"}
      </span>
      <button
        type="button"
        data-testid="disconnect-button"
        onClick={disconnect}
        className="min-h-11 self-start rounded-xl border border-[color:var(--m-border)] px-4 text-sm"
      >
        Lock wallet
      </button>
    </div>
  );
}
