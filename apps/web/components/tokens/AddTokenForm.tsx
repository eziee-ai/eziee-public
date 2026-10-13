"use client";

import { useState } from "react";
import { usePublicClient } from "wagmi";
import type { Address, PublicClient } from "viem";
import { createRateAdapter } from "@repo/protocols/rate";
import { BRAND } from "@repo/ui/brand";
import { addCustomToken } from "@/lib/tokens/customTokens";
import { tokenReader, verifyToken, type TokenCheck } from "@/lib/tokens/verifyToken";

const rate = createRateAdapter();

type State = { status: "idle" } | { status: "checking" } | { status: "done"; address: string; check: TokenCheck } | { status: "unavailable" };

const BUTTON = "min-h-11 rounded-xl px-4 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60";

/** Adds a token by address, only after the chain says it is an ERC-20. */
export function AddTokenForm({ chainId, chainName, account }: { chainId: number; chainName: string; account: string }) {
  const client = usePublicClient({ chainId });
  const [address, setAddress] = useState("");
  const [state, setState] = useState<State>({ status: "idle" });
  const [notice, setNotice] = useState<string | null>(null);

  async function check() {
    if (!client) return;
    setNotice(null);
    setState({ status: "checking" });
    try {
      const result = await verifyToken(tokenReader(client as PublicClient), chainId, address, rate.tokens(chainId), account as Address);
      setState({ status: "done", address, check: result });
    } catch {
      setState({ status: "unavailable" });
    }
  }

  function add(check: Extract<TokenCheck, { kind: "unreviewed" }>) {
    const saved = addCustomToken(chainId, account, check.token);
    setNotice(saved ? `${check.token.symbol} added.` : `${check.token.symbol} added for this page only. This browser is not saving site data.`);
    setAddress("");
    setState({ status: "idle" });
  }

  return (
    <section className="flex flex-col gap-3.5 rounded-2xl border border-[color:var(--m-border)] bg-[color:var(--m-surface)] p-5">
      <h2 className="text-[15px] font-semibold">Add a token</h2>
      <p className="text-[13px] text-[color:var(--m-text-secondary)]">Added tokens are only shown and sent from here. The assistant never trades them.</p>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void check();
        }}
      >
        <label htmlFor="add-token-address" className="sr-only">
          Token address on {chainName}
        </label>
        <input
          id="add-token-address"
          data-testid="add-token-address"
          value={address}
          onChange={(e) => {
            setAddress(e.target.value);
            setNotice(null);
            if (state.status !== "checking") setState({ status: "idle" });
          }}
          placeholder="0x…"
          autoComplete="off"
          spellCheck={false}
          className="h-11 min-w-0 flex-1 rounded-xl border border-[color:var(--m-border)] bg-[color:var(--m-background)] px-3 font-dm-mono text-sm"
        />
        <button type="submit" data-testid="add-token-check" disabled={!client || address.trim() === "" || state.status === "checking"} aria-busy={state.status === "checking"} className={`${BUTTON} border border-[color:var(--m-border)] hover:bg-[color:var(--m-surface-2)]`}>
          {state.status === "checking" ? "Checking…" : "Check"}
        </button>
      </form>

      {state.status === "unavailable" && (
        <p data-testid="add-token-result" role="alert" className="text-[13px] text-[color:var(--m-error-fg)]">
          {chainName} could not be reached, so the token was not checked. Nothing was added. Try again.
        </p>
      )}
      {state.status === "done" && state.address === address && <Result check={state.check} chainName={chainName} onAdd={add} />}
      {notice && (
        <p role="status" className="text-[13px] text-[color:var(--m-text-secondary)]">
          {notice}
        </p>
      )}
    </section>
  );
}

function Result({ check, chainName, onAdd }: { check: TokenCheck; chainName: string; onAdd: (check: Extract<TokenCheck, { kind: "unreviewed" }>) => void }) {
  const refusal = (text: string) => (
    <p data-testid="add-token-result" role="alert" className="text-[13px] text-[color:var(--m-error-fg)]">
      {text}
    </p>
  );
  switch (check.kind) {
    case "invalid-address":
      return refusal(check.reason);
    case "not-a-contract":
      return refusal(`Not a contract on ${chainName}. Nothing was added.`);
    case "not-erc20":
      return refusal(`Not an ERC-20: ${check.reason}`);
    case "reviewed":
      return (
        <p data-testid="add-token-result" role="status" className="text-[13px]">
          Already on the reviewed list as {check.token.symbol}. It is listed above.
        </p>
      );
    case "unreviewed":
      return (
        <div data-testid="add-token-result" role="status" className="flex flex-col gap-3 rounded-xl border border-[color:var(--m-border)] p-4">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]">
            <dt className="text-[color:var(--m-text-secondary)]">Symbol</dt>
            <dd className="font-semibold">{check.token.symbol}</dd>
            <dt className="text-[color:var(--m-text-secondary)]">Name</dt>
            <dd>{check.token.name}</dd>
            <dt className="text-[color:var(--m-text-secondary)]">Decimals</dt>
            <dd className="font-dm-mono">{check.token.decimals}</dd>
            <dt className="text-[color:var(--m-text-secondary)]">Address</dt>
            <dd className="break-all font-dm-mono">{check.token.address}</dd>
          </dl>
          <p className="text-[13px]">Not on the reviewed list. {BRAND} will show its balance and let you withdraw it. The assistant will not trade it.</p>
          <button type="button" data-testid="add-token-add" onClick={() => onAdd(check)} className={`${BUTTON} self-start bg-[color:var(--m-primary)] text-[color:var(--m-on-primary)] hover:bg-[color:var(--m-primary-hover)]`}>
            Add {check.token.symbol}
          </button>
        </div>
      );
  }
}
