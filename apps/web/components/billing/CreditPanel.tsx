"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useId, useMemo, useState } from "react";
import { encodeFunctionData, erc20Abi, formatUnits, type Address } from "viem";
import { useReadContract } from "wagmi";
import { formatUsd } from "@repo/agent/pricing";
import { cn } from "@repo/ui/cn";
import { useWalletAccount, useWalletConnect } from "@repo/wallet";
import type { WalletRpc } from "@repo/wallet/frame/protocol";
import { WalletConfirmFrame } from "@/components/wallet/WalletConfirmFrame";
import { addPendingTopUp, removePendingTopUp, usePendingTopUps, type PendingTopUp } from "@/lib/billing/pendingTopUps";
import { checkTopUp, depositNeeded, pollDelayMs, STALE_AFTER_MS } from "@/lib/billing/topUp";
import { appChains } from "@/lib/chains";
import { radioKeys, rovingTabIndex } from "@/lib/radioKeys";
import { useAppSession } from "@/lib/session/useAppSession";

interface Billing {
  credit: { balanceMicrousd: string; spendableMicrousd: string; heldMicrousd: string; blocked: boolean };
  rails: string[];
  usdcStatus: "off" | "ready" | "unreachable";
  usdc: { treasury: Address; confirmations: number; maxPerTopUpMicrousd: string; chains: Array<{ chainId: number; token: Address; decimals: number; test: boolean }> } | null;
  tokenRail: { treasury: Address; confirmations: number; maxPerTopUpMicrousd: string; leftTodayMicrousd: string; tokens: Array<{ chainId: number; token: Address; symbol: string; decimals: number; microusdPerToken: string; faucet: boolean; test: boolean }> } | null;
  ledger: Array<{ id: string; deltaMicrousd: string; kind: string; test: boolean; createdAt: string }>;
}
type Claim = { status: "credited"; creditedMicrousd: string } | { status: "already-credited" } | { status: "pending"; confirmations: number; needed: number } | { status: "rejected"; reason: string };

const CARD = "flex flex-col gap-3.5 rounded-2xl border border-[color:var(--m-border)] bg-[color:var(--m-surface)] p-5";
const PRIMARY = "min-h-11 rounded-xl bg-[color:var(--m-primary)] px-5 text-sm font-semibold text-[color:var(--m-on-primary)] hover:bg-[color:var(--m-primary-hover)] disabled:cursor-not-allowed disabled:opacity-55";
const SECONDARY = "min-h-11 rounded-xl border border-[color:var(--m-border)] px-4 text-sm font-semibold hover:bg-[color:var(--m-surface-2)]";
const PACKS = ["5", "10", "25", "50"];
const KINDS: Record<string, string> = { topup_usdc: "Added with USDC", topup_card: "Added by card", topup_token: "Added with tokens", usage: "Model usage", refund: "Refund", adjustment: "Adjustment" };

class ClaimError extends Error {
  constructor(readonly retryAfterSeconds?: number) {
    super("claim");
  }
}
const clock = { now: () => Date.now() };

/** One deposit on its way: asks the server until it is credited or refused, then settles itself. */
function PendingRow({ entry, onSettled }: { entry: PendingTopUp; onSettled: () => void }) {
  const claim = useQuery({
    queryKey: ["usdc-claim", entry.chainId, entry.hash],
    queryFn: async (): Promise<Claim> => {
      const response = entry.token
        ? await fetch("/api/billing/token", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chainId: entry.chainId, token: entry.token, hash: entry.hash }) })
        : await fetch("/api/billing/usdc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chainId: entry.chainId, hash: entry.hash }) });
      // The token was switched off after this was sent: asking again will not change that.
      if (response.status === 404 && entry.token) return { status: "rejected", reason: "This token no longer buys credit here, so this deposit was not credited. Contact the operator of this app with the transaction hash." };
      if (!response.ok) throw new ClaimError(((await response.json().catch(() => ({}))) as { retryAfterSeconds?: number }).retryAfterSeconds);
      const result = (await response.json()) as Claim;
      if (result.status === "credited" || result.status === "already-credited") onSettled();
      return result;
    },
    // The money has moved, so this does not give up: it asks while the deposit confirms, less often after failures
    // or when it is taking long, and as often as the server says when the server says.
    refetchInterval: (query) =>
      pollDelayMs({
        settled: query.state.data !== undefined && query.state.data.status !== "pending",
        failures: query.state.fetchFailureCount,
        ageMs: clock.now() - (entry.sentAt ?? 0),
        retryAfterSeconds: query.state.error instanceof ClaimError ? query.state.error.retryAfterSeconds : undefined,
      }),
    // People send a deposit and switch to something else while it confirms. That is when this must keep checking.
    refetchIntervalInBackground: true,
    retry: false,
  });
  const chain = appChains.find((c) => c.id === entry.chainId);
  const data = claim.data;
  const done = data?.status === "credited" || data?.status === "already-credited";
  const unseen = data?.status === "pending" && data.confirmations === 0 && claim.dataUpdatedAt - (entry.sentAt ?? 0) > STALE_AFTER_MS;

  return (
    <li data-testid="pending-topup" className="flex flex-col gap-2 rounded-xl border border-[color:var(--m-border)] p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold">
          {entry.amount ? `${entry.amount} ${entry.symbol ?? "USDC"}` : "A deposit"} on {chain?.name ?? `chain ${entry.chainId}`}
        </span>
        <span data-testid="pending-topup-status" className="text-[13px] text-[color:var(--m-text-secondary)]">
          {done ? "Credited" : data?.status === "rejected" ? "Not credited" : unseen ? "Not seen on the chain" : data?.status === "pending" ? `Confirming: ${data.confirmations} of ${data.needed}` : claim.isError ? "Could not be checked yet; trying again" : "Checking…"}
        </span>
      </div>
      <code className="break-all font-dm-mono text-xs text-[color:var(--m-text-secondary)]">{entry.hash}</code>
      {data?.status === "rejected" && <p className="text-[13px] text-[color:var(--m-error-fg)]">{data.reason}</p>}
      {unseen && <p className="text-[13px] text-[color:var(--m-text-secondary)]">This transaction has not appeared on the chain. If it was dropped or replaced, nothing left your wallet. It will still be credited if it confirms later, whether or not you keep it here.</p>}
      {/* Always there: a record of a deposit that will never confirm must not be permanent. Removing it loses nothing; the server credits by hash. */}
      <button type="button" data-testid="pending-topup-dismiss" onClick={() => removePendingTopUp(entry.hash)} className={cn(SECONDARY, "self-start")}>
        {done || data?.status === "rejected" ? "Dismiss" : "Stop showing this"}
      </button>
    </li>
  );
}

/** The way back for a deposit this page has no record of: sent from another device, or lost when the page was left mid-send. */
function ClaimByHash({ chains, account }: { chains: NonNullable<Billing["usdc"]>["chains"]; account: Address }) {
  const [hash, setHash] = useState("");
  const [chainId, setChainId] = useState(chains[0]!.chainId);
  const valid = /^0x[0-9a-fA-F]{64}$/.test(hash.trim());
  return (
    <details className="text-sm">
      <summary className="min-h-11 cursor-pointer py-2.5 font-medium text-[color:var(--m-primary-fg)]">Already sent USDC and do not see it here?</summary>
      <form
        className="flex flex-col gap-2 pt-1"
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid) return;
          addPendingTopUp({ chainId, hash: hash.trim() as `0x${string}`, amount: "", account, sentAt: clock.now() });
          setHash("");
        }}
      >
        <label htmlFor="claim-hash" className="text-[13px] font-medium">
          Transaction hash
        </label>
        <input id="claim-hash" data-testid="claim-hash" value={hash} onChange={(e) => setHash(e.target.value)} autoComplete="off" spellCheck={false} placeholder="0x followed by 64 characters" className="h-11 rounded-xl border border-[color:var(--m-border)] bg-transparent px-3 font-dm-mono text-[13px]" />
        {chains.length > 1 && (
          <select aria-label="Network" value={chainId} onChange={(e) => setChainId(Number(e.target.value))} className="h-11 rounded-xl border border-[color:var(--m-border)] bg-transparent px-3 text-sm">
            {chains.map((c) => (
              <option key={c.chainId} value={c.chainId}>
                {appChains.find((a) => a.id === c.chainId)?.name ?? c.chainId}
              </option>
            ))}
          </select>
        )}
        <p className="text-[13px] text-[color:var(--m-text-secondary)]">It is credited only if it sent USDC from this wallet to the top-up address. Checking a hash costs nothing and cannot credit anyone else.</p>
        <button type="submit" data-testid="claim-submit" disabled={!valid} className={cn(SECONDARY, "self-start disabled:cursor-not-allowed disabled:opacity-55")}>
          Check this transaction
        </button>
      </form>
    </details>
  );
}

/** One way to pay: USDC on its networks, or one of the operator's tokens on its network. */
interface PayWith {
  symbol: string;
  treasury: Address;
  confirmations: number;
  maxPerTopUpMicrousd: string;
  chains: Array<{ chainId: number; token: Address; decimals: number; test: boolean }>;
  /** Credit one whole token buys. One dollar for USDC. */
  microusdPerToken: bigint;
  /** The operator's token, sent to /api/billing/token; absent for USDC. */
  operatorToken: boolean;
  /** The contract has an open faucet (`claim()`). */
  faucet: boolean;
  /** A limit worth saying up front. */
  note?: string;
}

const USDC_MICRO = 1_000_000n;
const TEST_TOKEN_ABI = [
  { type: "function", name: "claim", inputs: [], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "nextClaimAt", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
] as const;

/** "Get test tokens": the token's own faucet, through the wallet like any other transaction. */
function Faucet({ token, chainId, symbol, account, onClaimed }: { token: Address; chainId: number; symbol: string; account: Address; onClaimed: () => void }) {
  const [asking, setAsking] = useState(false);
  const [sent, setSent] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // Read again every so often: after a claim the new time appears once it is mined, and a wait that ends turns the button back on.
  const next = useReadContract({ chainId, address: token, abi: TEST_TOKEN_ABI, functionName: "nextClaimAt", args: [account], query: { refetchInterval: 5_000 } });
  const rpc = useMemo<WalletRpc>(() => ({ method: "eth_sendTransaction", params: [{ from: account, to: token, data: encodeFunctionData({ abi: TEST_TOKEN_ABI, functionName: "claim" }), value: "0x0" }] }), [account, token]);
  // Compared with when the answer was read, not with the clock during render.
  const waitUntil = next.data !== undefined && next.data * 1000n > BigInt(next.dataUpdatedAt) ? new Date(Number(next.data) * 1000) : null;
  // Sent and not yet seen on the chain: the old time still reads as "now", and a second claim would only revert.
  const pending = sent && waitUntil === null;
  if (asking) {
    return (
      <div className="flex flex-col gap-2">
        <WalletConfirmFrame chainId={chainId} rpc={rpc} label={`Get test ${symbol}`} onSubmitted={() => (setAsking(false), setSent(true), onClaimed())} onFailed={(error) => (setAsking(false), setFailure(error.code === 4001 ? null : error.message))} />
        <button type="button" onClick={() => setAsking(false)} className={cn(SECONDARY, "self-start")}>
          Back
        </button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <button type="button" data-testid="faucet-claim" disabled={waitUntil !== null || pending} onClick={() => (setFailure(null), setAsking(true))} className={cn(PRIMARY, "self-start")}>
        Get test {symbol}
      </button>
      {pending && <p className="text-[13px]">Sent. The tokens arrive once it is confirmed.</p>}
      {waitUntil && <p className="text-[13px]">This wallet can get more after {waitUntil.toLocaleString()}.</p>}
      {failure && <p role="alert" className="text-[13px] text-[color:var(--m-error-fg)]">{failure}</p>}
    </div>
  );
}

function TopUp({ pay, account, onSent }: { pay: PayWith; account: Address; onSent: () => void }) {
  const [chainId, setChainId] = useState(pay.chains[0]!.chainId);
  const [amount, setAmount] = useState(pay.operatorToken ? "" : "5");
  const [review, setReview] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const token = pay.chains.find((c) => c.chainId === chainId) ?? pay.chains[0]!;
  const chain = appChains.find((c) => c.id === token.chainId);

  // Watched while a faucet claim may be on its way, so the new balance shows without a reload.
  const held = useReadContract({ chainId: token.chainId, address: token.token, abi: erc20Abi, functionName: "balanceOf", args: [account], query: { refetchInterval: pay.faucet ? 5_000 : false } });
  const limits = { decimals: token.decimals, held: held.data, maxMicrousd: BigInt(pay.maxPerTopUpMicrousd), symbol: pay.symbol, microusdPerToken: pay.microusdPerToken };
  const check = checkTopUp(amount, limits);
  const problem = check.ok ? null : check.message;
  const deposit = depositNeeded(amount, limits);
  const sym = pay.symbol;
  const amountId = useId();
  const units = check.ok ? check.amount : 0n;

  // The wallet shows this for what it is, a transfer to an address, and always asks: no rule can cover a transfer.
  // Memoised: the confirm frame re-presents the request whenever this object changes, and it must not change under the cursor.
  const rpc = useMemo<WalletRpc>(() => ({ method: "eth_sendTransaction", params: [{ from: account, to: token.token, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [pay.treasury, units] }), value: "0x0" }] }), [account, token.token, pay.treasury, units]);

  return (
    <section className={CARD}>
      <h2 className="text-[15px] font-semibold">Add credit with {sym}</h2>
      <p className="text-sm text-[color:var(--m-text-secondary)]">
        {pay.operatorToken ? `Send ${sym} from your wallet: 1 ${sym} buys ${formatUsd(pay.microusdPerToken)} of credit.` : "Send USDC from your wallet and receive the same amount in credit: 1 USDC is $1.00."} It is credited after {pay.confirmations} confirmation{pay.confirmations === 1 ? "" : "s"}.{pay.note && ` ${pay.note}`}
        {token.test && " This is a test network, so what it buys is test credit."}
      </p>

      {pay.chains.length > 1 && (
        <div role="radiogroup" aria-label="Network" onKeyDown={radioKeys} className="flex rounded-full bg-[color:var(--m-surface-2)] p-1">
          {pay.chains.map((c) => (
            <button key={c.chainId} type="button" role="radio" aria-checked={c.chainId === token.chainId} tabIndex={rovingTabIndex(c.chainId === token.chainId, false, true)} disabled={review} onClick={() => setChainId(c.chainId)} className={cn("min-h-10 flex-1 rounded-full text-[13px] font-semibold", c.chainId === token.chainId && "bg-[color:var(--m-background)] shadow-[0_0_0_1px_var(--m-border)]")}>
              {appChains.find((a) => a.id === c.chainId)?.name ?? c.chainId}
            </button>
          ))}
        </div>
      )}

      {!pay.operatorToken && <div className="flex flex-wrap gap-2">
        {PACKS.map((pack) => (
          <button key={pack} type="button" aria-pressed={amount === pack} disabled={review} onClick={() => setAmount(pack)} className={cn(SECONDARY, amount === pack && "border-[color:var(--m-primary)] bg-[color:var(--m-surface-selected)] text-[color:var(--m-on-surface-selected)]")}>
            ${pack}
          </button>
        ))}
      </div>}
      <div className="flex flex-col gap-1.5">
        <label htmlFor={amountId} className="text-[13px] font-medium">
          Amount in {sym}
        </label>
        <input id={amountId} data-testid="topup-amount" inputMode="decimal" autoComplete="off" disabled={review} value={amount} onChange={(e) => setAmount(e.target.value.trim())} aria-invalid={problem !== null} aria-describedby={`${amountId}-note`} className="h-11 rounded-xl border border-[color:var(--m-border)] bg-transparent px-3 font-dm-mono text-[15px]" />
        <p id={`${amountId}-note`} className={cn("text-[13px]", problem ? "text-[color:var(--m-error-fg)]" : "text-[color:var(--m-text-secondary)]")}>
          {problem ?? (held.data !== undefined ? `This wallet holds ${formatUnits(held.data, token.decimals)} ${sym} on ${chain?.name}.` : " ")}
        </p>
      </div>

      {deposit && !review && (
        <div data-testid="topup-deposit-first" className="flex flex-col gap-3 rounded-xl border border-[color:var(--m-warning-300)] bg-[color:var(--m-warning-100)] p-3 text-[color:var(--m-warning-700)] dark:border-[color:var(--m-warning-700)] dark:bg-[color:var(--m-warning-800)] dark:text-[color:var(--m-warning-300)]">
          <p className="text-sm font-medium">
            {deposit === "empty" ? `This wallet has no ${sym} on ${chain?.name}. ${pay.faucet ? "Get some from the faucet" : `Deposit ${sym} to it`} first, then pay from it here.` : `This wallet does not hold enough ${sym} on ${chain?.name} for this amount. ${pay.faucet ? "Get more from the faucet" : "Deposit more"}, or pay a smaller amount.`}
          </p>
          {pay.faucet ? (
            <Faucet token={token.token} chainId={token.chainId} symbol={sym} account={account} onClaimed={() => void held.refetch()} />
          ) : (
            <Link href="/deposit" data-testid="topup-deposit-link" className={cn(PRIMARY, "flex items-center self-start")}>
              Deposit {sym}
            </Link>
          )}
        </div>
      )}

      {!review ? (
        <button type="button" data-testid="topup-review" disabled={problem !== null} onClick={() => (setFailure(null), setReview(true))} className={cn(PRIMARY, "self-start")}>
          Review
        </button>
      ) : (
        <div className="flex flex-col gap-3 rounded-xl border border-[color:var(--m-border)] bg-[color:var(--m-background)] p-3">
          <dl className="flex flex-col gap-2 text-[13px]">
            <div className="flex justify-between gap-4">
              <dt className="text-[color:var(--m-text-secondary)]">You send</dt>
              <dd data-testid="topup-review-amount" className="font-dm-mono">
                {check.ok ? check.text : amount} {sym}
              </dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-[color:var(--m-text-secondary)]">To this app&rsquo;s top-up address on {chain?.name}</dt>
              <dd data-testid="topup-review-treasury" className="break-all font-dm-mono">
                {pay.treasury}
              </dd>
            </div>
          </dl>
          <p className="text-[13px] text-[color:var(--m-text-secondary)]">Your wallet will show this transfer and ask you. Check that the address there is the one above. A transfer cannot be undone. Only a transfer sent from this wallet is credited: do not send to this address from an exchange or another wallet.</p>
          <WalletConfirmFrame
            chainId={token.chainId}
            rpc={rpc}
            label={`Send ${amount} ${sym}`}
            onSubmitted={(hash) => {
              addPendingTopUp({ chainId: token.chainId, hash, amount: check.ok ? check.text : amount, account, sentAt: clock.now(), ...(pay.operatorToken ? { token: token.token, symbol: sym } : {}) });
              setReview(false);
              onSent();
            }}
            onFailed={(error) => (setReview(false), setFailure(error.code === 4001 ? null : error.message))}
          />
          <button type="button" onClick={() => setReview(false)} className={cn(SECONDARY, "self-start")}>
            Back
          </button>
          <p className="text-[13px] text-[color:var(--m-text-secondary)]">If you have already approved it in your wallet, stay here until it shows as sent. If it is ever missing from this page, its transaction hash can be checked below.</p>
        </div>
      )}
      {failure && (
        <p role="alert" className="text-[13px] text-[color:var(--m-error-fg)]">
          {failure}
        </p>
      )}
    </section>
  );
}

export function CreditPanel() {
  const queryClient = useQueryClient();
  const session = useAppSession();
  const { address, isConnected } = useWalletAccount();
  const { open, ready } = useWalletConnect();
  const pending = usePendingTopUps().filter((entry) => address && entry.account.toLowerCase() === address.toLowerCase());
  const billing = useQuery({
    queryKey: ["billing", session.address ?? null],
    enabled: session.signedIn,
    queryFn: async (): Promise<Billing> => {
      const response = await fetch("/api/billing", { cache: "no-store" });
      if (!response.ok) throw new Error("billing");
      return (await response.json()) as Billing;
    },
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["billing"] });
    void session.refresh();
  };

  if (!isConnected || !address) {
    return (
      <section className={CARD}>
        <h2 className="text-[15px] font-semibold">Connect to see your credit</h2>
        <p className="text-sm text-[color:var(--m-text-secondary)]">Credit belongs to your wallet address.</p>
        <button type="button" disabled={!ready} onClick={open} className={cn(PRIMARY, "self-start")}>
          Continue with a passkey
        </button>
      </section>
    );
  }
  if (!session.signedIn || billing.isPending) return <p className="text-sm text-[color:var(--m-text-secondary)]">{session.error ?? "Loading your credit…"}</p>;
  if (billing.isError) {
    return (
      <p role="alert" className="text-sm text-[color:var(--m-error-fg)]">
        Your credit could not be loaded. Reload the page to try again.
      </p>
    );
  }
  const data = billing.data;
  const held = BigInt(data.credit.heldMicrousd);

  return (
    <>
      <section className={CARD}>
        <h2 className="text-[15px] font-semibold">Credit</h2>
        <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span data-testid="credit-spendable" className="font-dm-mono text-4xl font-medium tracking-tight">
            {formatUsd(BigInt(data.credit.spendableMicrousd))}
          </span>
          <span className="text-sm text-[color:var(--m-text-secondary)]">ready to spend{held > 0n ? `, ${formatUsd(held)} held for a reply in progress` : ""}</span>
        </p>
        <p className="text-sm text-[color:var(--m-text-secondary)]">Each reply is charged what the model cost, shown under the reply. Credit is not a balance of any currency and cannot be withdrawn.</p>
        {data.credit.blocked && (
          <p role="alert" className="text-sm font-medium text-[color:var(--m-error-fg)]">
            This account is blocked because its balance went below zero after a refund. Add credit to restore it.
          </p>
        )}
      </section>

      {pending.length > 0 && (
        <section className={CARD}>
          <h2 className="text-[15px] font-semibold">On its way</h2>
          <ul className="flex flex-col gap-2">
            {pending.map((entry) => (
              <PendingRow key={entry.hash} entry={entry} onSettled={refresh} />
            ))}
          </ul>
        </section>
      )}

      {data.tokenRail?.tokens.map((t) => (
        <TopUp key={`${t.chainId}:${t.token}`} pay={{ symbol: t.symbol, treasury: data.tokenRail!.treasury, confirmations: data.tokenRail!.confirmations, maxPerTopUpMicrousd: data.tokenRail!.maxPerTopUpMicrousd, chains: [{ chainId: t.chainId, token: t.token, decimals: t.decimals, test: t.test }], microusdPerToken: BigInt(t.microusdPerToken), operatorToken: true, faucet: t.faucet, note: `This account can buy ${formatUsd(BigInt(data.tokenRail!.leftTodayMicrousd))} more credit with the app's tokens today.` }} account={address} onSent={refresh} />
      ))}

      {data.usdc ? (
        <>
          <TopUp pay={{ symbol: "USDC", treasury: data.usdc.treasury, confirmations: data.usdc.confirmations, maxPerTopUpMicrousd: data.usdc.maxPerTopUpMicrousd, chains: data.usdc.chains, microusdPerToken: USDC_MICRO, operatorToken: false, faucet: false }} account={address} onSent={refresh} />
          <section className={CARD}>
            <ClaimByHash chains={data.usdc.chains} account={address} />
          </section>
        </>
      ) : data.usdcStatus === "unreachable" ? (
        <section className={CARD}>
          <h2 className="text-[15px] font-semibold">Add credit with USDC</h2>
          <p data-testid="topup-unreachable" role="status" className="text-sm text-[color:var(--m-text-secondary)]">
            Adding credit is switched on, but the network could not be checked just now. Nothing is wrong with your credit. Try again in a minute.
          </p>
        </section>
      ) : data.tokenRail ? null : (
        <section className={CARD}>
          <h2 className="text-[15px] font-semibold">Add credit</h2>
          <p data-testid="credit-no-rails" className="text-sm text-[color:var(--m-text-secondary)]">
            No way to add credit is switched on for this deployment yet. The operator can add credit to an account directly.
          </p>
        </section>
      )}

      <section className={CARD}>
        <h2 className="text-[15px] font-semibold">Recent activity</h2>
        {data.ledger.length === 0 ? (
          <p className="text-sm text-[color:var(--m-text-secondary)]">Nothing yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <thead className="text-[color:var(--m-text-secondary)]">
                <tr>
                  <th scope="col" className="py-1.5 pr-3 font-medium">When</th>
                  <th scope="col" className="py-1.5 pr-3 font-medium">What</th>
                  <th scope="col" className="py-1.5 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {data.ledger.map((row) => {
                  const delta = BigInt(row.deltaMicrousd);
                  return (
                    <tr key={row.id} className="border-t border-[color:var(--m-border)]">
                      <td className="whitespace-nowrap py-2 pr-3 text-[color:var(--m-text-secondary)]">{new Date(row.createdAt).toLocaleString()}</td>
                      <td className="py-2 pr-3">
                        {KINDS[row.kind] ?? row.kind}
                        {row.test && <span className="ml-2 rounded-full bg-[color:var(--m-surface-2)] px-2 py-0.5 text-[11px] font-semibold">Test</span>}
                      </td>
                      <td className="whitespace-nowrap py-2 text-right font-dm-mono">
                        {delta >= 0n ? "+" : "−"}
                        {formatUsd(delta >= 0n ? delta : -delta)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
