"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { formatUsd } from "@repo/agent/pricing";
import { cn } from "@repo/ui/cn";
import { useWalletAccount, useWalletConnect } from "@repo/wallet";
import { useAppSession } from "@/lib/session/useAppSession";

interface Token {
  chainId: number;
  address: `0x${string}`;
  symbol: string;
  decimals: number;
  microusdPerToken: string;
  enabled: boolean;
  faucet: boolean;
  updatedBy: string;
  updatedAt: string;
}
interface Listing {
  tokens: Token[];
  chains: Array<{ id: number; name: string; testnet: boolean }>;
}
interface Draft {
  chainId: number;
  address: string;
  priceUsd: string;
  enabled: boolean;
  faucet: boolean;
}

const CARD = "flex flex-col gap-3.5 rounded-2xl border border-[color:var(--m-border)] bg-[color:var(--m-surface)] p-5";
const PRIMARY = "min-h-11 rounded-xl bg-[color:var(--m-primary)] px-5 text-sm font-semibold text-[color:var(--m-on-primary)] hover:bg-[color:var(--m-primary-hover)] disabled:cursor-not-allowed disabled:opacity-55";
const SECONDARY = "min-h-11 rounded-xl border border-[color:var(--m-border)] px-4 text-sm font-semibold hover:bg-[color:var(--m-surface-2)]";
const FIELD = "h-11 rounded-xl border border-[color:var(--m-border)] bg-transparent px-3 text-sm";

/** Micro-USD as the dollars an admin typed, without trailing zeros: 10000 → "0.01". */
const toUsd = (micro: string) => (Number(micro) / 1_000_000).toFixed(6).replace(/\.?0+$/, "");

async function save(draft: Draft): Promise<void> {
  const response = await fetch("/api/admin/payment-tokens", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(draft) });
  if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: { message?: string } }).error?.message ?? "The token could not be saved.");
}

function TokenForm({ chains, initial, submitLabel, onDone, lockIdentity }: { chains: Listing["chains"]; initial: Draft; submitLabel: string; onDone?: () => void; lockIdentity?: boolean }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(initial);
  const mutation = useMutation({ mutationFn: save, onSuccess: () => (void queryClient.invalidateQueries({ queryKey: ["admin-payment-tokens"] }), onDone?.()) });
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        mutation.mutate(draft);
      }}
    >
      {!lockIdentity && (
        <>
          <label className="flex flex-col gap-1.5 text-[13px] font-medium">
            Network
            <select value={draft.chainId} onChange={(e) => set({ chainId: Number(e.target.value) })} className={FIELD}>
              {chains.map((chain) => (
                <option key={chain.id} value={chain.id}>
                  {chain.name}
                  {chain.testnet ? " (testnet)" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1.5 text-[13px] font-medium">
            Token contract
            <input data-testid="admin-token-address" value={draft.address} onChange={(e) => set({ address: e.target.value.trim() })} placeholder="0x…" autoComplete="off" spellCheck={false} className={cn(FIELD, "font-dm-mono")} />
          </label>
        </>
      )}
      <label className="flex flex-col gap-1.5 text-[13px] font-medium">
        Credit one token buys, in dollars
        <input data-testid="admin-token-price" value={draft.priceUsd} onChange={(e) => set({ priceUsd: e.target.value.trim() })} inputMode="decimal" placeholder="0.01" autoComplete="off" className={cn(FIELD, "font-dm-mono")} />
      </label>
      <label className="flex min-h-11 items-center gap-2.5 text-sm">
        <input type="checkbox" checked={draft.enabled} onChange={(e) => set({ enabled: e.target.checked })} className="h-4 w-4" /> People can pay with it
      </label>
      <label className="flex min-h-11 items-center gap-2.5 text-sm">
        <input type="checkbox" checked={draft.faucet} onChange={(e) => set({ faucet: e.target.checked })} className="h-4 w-4" /> It has an open faucet (offer &ldquo;Get test tokens&rdquo;)
      </label>
      {mutation.isError && (
        <p role="alert" className="text-[13px] text-[color:var(--m-error-fg)]">
          {mutation.error.message}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="submit" data-testid="admin-token-save" disabled={mutation.isPending} className={PRIMARY}>
          {mutation.isPending ? "Checking the chain…" : submitLabel}
        </button>
        {onDone && (
          <button type="button" onClick={onDone} className={SECONDARY}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

function TokenRow({ token, chains }: { token: Token; chains: Listing["chains"] }) {
  const [editing, setEditing] = useState(false);
  const chain = chains.find((c) => c.id === token.chainId);
  return (
    <li data-testid="admin-token-row" className="flex flex-col gap-2 rounded-xl border border-[color:var(--m-border)] p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold">
          {token.symbol} <span className="font-normal text-[color:var(--m-text-secondary)]">on {chain?.name ?? token.chainId}</span>
        </span>
        <span className="text-[13px] text-[color:var(--m-text-secondary)]">{token.enabled ? "On" : "Off"}{token.faucet ? " · faucet" : ""}</span>
      </div>
      <code className="break-all font-dm-mono text-xs text-[color:var(--m-text-secondary)]">{token.address}</code>
      <p>
        1 {token.symbol} buys <span className="font-dm-mono">{formatUsd(BigInt(token.microusdPerToken))}</span> of credit · {token.decimals} decimals
      </p>
      {editing ? (
        <TokenForm chains={chains} lockIdentity initial={{ chainId: token.chainId, address: token.address, priceUsd: toUsd(token.microusdPerToken), enabled: token.enabled, faucet: token.faucet }} submitLabel="Save" onDone={() => setEditing(false)} />
      ) : (
        <button type="button" onClick={() => setEditing(true)} className={cn(SECONDARY, "self-start")}>
          Edit
        </button>
      )}
    </li>
  );
}

export function PaymentTokensAdmin() {
  const session = useAppSession();
  const { isConnected } = useWalletAccount();
  const { open, ready } = useWalletConnect();
  const [adding, setAdding] = useState(false);
  const listing = useQuery({
    queryKey: ["admin-payment-tokens"],
    enabled: session.admin,
    queryFn: async (): Promise<Listing> => {
      const response = await fetch("/api/admin/payment-tokens", { cache: "no-store" });
      if (!response.ok) throw new Error("admin");
      return (await response.json()) as Listing;
    },
  });

  if (!isConnected) {
    return (
      <section className={CARD}>
        <h2 className="text-[15px] font-semibold">Connect an admin wallet</h2>
        <button type="button" disabled={!ready} onClick={open} className={cn(PRIMARY, "self-start")}>
          Continue with a passkey
        </button>
      </section>
    );
  }
  if (!session.signedIn) return <p className="text-sm text-[color:var(--m-text-secondary)]">{session.error ?? "Signing you in…"}</p>;
  if (!session.admin) {
    return (
      <section data-testid="admin-denied" className={CARD}>
        <h2 className="text-[15px] font-semibold">Not an admin</h2>
        <p className="text-sm text-[color:var(--m-text-secondary)]">This wallet is not on this app&rsquo;s admin list.</p>
      </section>
    );
  }
  if (listing.isPending) return <p className="text-sm text-[color:var(--m-text-secondary)]">Loading…</p>;
  if (listing.isError) return <p role="alert" className="text-sm text-[color:var(--m-error-fg)]">The payment tokens could not be loaded.</p>;
  const { tokens, chains } = listing.data;

  return (
    <section className={CARD}>
      <h2 className="text-[15px] font-semibold">Payment tokens</h2>
      <p className="text-sm text-[color:var(--m-text-secondary)]">Symbol and decimals are read from the chain. A price change applies to deposits checked after it, including ones already sent.</p>
      {tokens.length === 0 ? (
        <p className="text-sm text-[color:var(--m-text-secondary)]">None yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {tokens.map((token) => (
            <TokenRow key={`${token.chainId}:${token.address}`} token={token} chains={chains} />
          ))}
        </ul>
      )}
      {adding ? (
        <TokenForm chains={chains} initial={{ chainId: chains[0]?.id ?? 0, address: "", priceUsd: "0.01", enabled: true, faucet: true }} submitLabel="Add token" onDone={() => setAdding(false)} />
      ) : (
        <button type="button" data-testid="admin-token-add" onClick={() => setAdding(true)} className={cn(PRIMARY, "self-start")}>
          Add a token
        </button>
      )}
    </section>
  );
}
