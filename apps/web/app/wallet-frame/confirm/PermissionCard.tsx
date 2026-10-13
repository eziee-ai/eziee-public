"use client";

import { useEffect, useState } from "react";
import { protocolBrand } from "@/lib/protocols/brand";
import { formatUnits, type Address, type Hex } from "viem";
import { walletConfig } from "@repo/wallet/config";
import { allowAlways } from "@repo/wallet/frame/allow";
import { normalise, safely } from "@repo/wallet/frame/evaluate";
import { describe, describeLines, type TokenMeta } from "@repo/wallet/frame/policy";
import { ERR, toFrameError, type FrameError, type WalletRpc } from "@repo/wallet/frame/protocol";
import type { DecodedApprovalForRules, DecodedForDisplay, Rule } from "@repo/wallet/frame/rules";
import { draftRule, parseCap, ruleEligibility } from "@repo/wallet/frame/scope";
import { executeSigned, sessionStatus } from "@repo/wallet/frame/signer";
import { appChains } from "@/lib/chains";

/**
 * The permission card: what this transaction IS, as the wallet decodes it, and
 * the three answers (spec §5.4). It is drawn on the wallet origin from calldata
 * and onchain reads only. Nothing the app says about the transaction appears
 * here, which is the point: a compromised app cannot describe a drain as a swap.
 *
 * The app CAN swap the request under the user's cursor (present A, wait for the
 * hand to move, present B). So this component is mounted with a `key` that
 * changes with the request: every swap is a fresh card with its editor closed,
 * its limits cleared, its buttons dead for a moment, and a line saying that the
 * request changed.
 */

const DAY_MS = 86_400_000;
/** Long enough that a click aimed at the previous request cannot land on this one. */
const ARM_DELAY_MS = 750;

// Read in event handlers only, through here: the clock and the id generator are impure, and
// keeping them out of the component body is what lets the compiler treat a render as pure.
const clock = { now: () => Date.now(), id: () => crypto.randomUUID() };

interface KnownToken {
  symbol: string;
  decimals: number;
}
type Expiry = "session" | "7d" | "30d";

const BUTTON = "min-h-11 rounded-xl border border-[color:var(--m-border)] px-4 text-sm font-semibold transition-colors hover:bg-[color:var(--m-surface-2)] disabled:cursor-not-allowed disabled:opacity-60";
const PRIMARY = "min-h-11 rounded-xl bg-[color:var(--m-primary)] px-4 text-sm font-semibold text-[color:var(--m-on-primary)] transition-colors hover:bg-[color:var(--m-primary-hover)] disabled:cursor-not-allowed disabled:opacity-60";
const FIELD = "h-11 w-full rounded-xl border border-[color:var(--m-border)] bg-[color:var(--m-background)] px-3 font-dm-mono text-sm";

/** "addLiquidity" reads as "Add liquidity". */
function words(action: string): string {
  const spaced = action.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Token metadata is per chain: the same address can be a different token elsewhere. */
export const tokenKey = (chainId: number, token: string) => `${chainId}:${token.toLowerCase()}`;

/**
 * The wallet's own decode of a request, or null. `normalise` refuses a transaction that carries
 * any field a decode does not cover (an EIP-7702 authorization above all), so such a request is
 * never shown as "a swap": it falls to the raw description, which names the delegation.
 */
export async function decodeForCard(chainId: number, rpc: WalletRpc | null, account: Address | null): Promise<DecodedForDisplay | null> {
  if (!rpc || !account) return null;
  const tx = normalise(chainId, rpc);
  return tx ? safely(() => walletConfig().decodeAction?.(tx, account)) : null;
}

export interface PermissionCardProps {
  chainId: number;
  rpc: WalletRpc | null;
  /** The frame's decode of `rpc`, or null when it is not a recognised action. Undefined while it is being worked out. */
  decoded: DecodedForDisplay | null | undefined;
  disabled: boolean;
  /** True when this card replaced a different request that was on screen. */
  replaced: boolean;
  tokens: Record<string, TokenMeta>;
  onSubmitted: (hash: Hex) => void;
  onFailed: (error: FrameError) => void;
}

/** An approval this large is unlimited in effect: no token's supply comes near 2^128 base units. */
const UNLIMITED_FROM = 2n ** 128n;

export function PermissionCard({ chainId, rpc, decoded, disabled, replaced, tokens, onSubmitted, onFailed }: PermissionCardProps) {
  const [mode, setMode] = useState<"answer" | "scope">("answer");
  const [perTx, setPerTx] = useState("");
  const [perDay, setPerDay] = useState("");
  const [expiry, setExpiry] = useState<Expiry>("session");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // Dead on arrival, armed after a beat. This component remounts per request, so the beat restarts on every swap.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setArmed(true), ARM_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, []);

  const chain = appChains.find((c) => c.id === chainId);
  const session = sessionStatus();
  const known = decoded ?? null;
  // An exact approval to a contract the manifest names. It is never an action, so it is described here by name.
  const [approval, setApproval] = useState<DecodedApprovalForRules | null>(null);
  useEffect(() => {
    let live = true;
    const tx = rpc && !known ? normalise(chainId, rpc) : null;
    void (tx ? safely(() => walletConfig().decodeApproval?.(tx)) : Promise.resolve(null)).then((found) => live && setApproval(found ?? null));
    return () => {
      live = false;
    };
  }, [chainId, rpc, known]);
  const eligibility = ruleEligibility(known);
  const spend = known?.spends ? known.spend[0] : undefined;

  // A token whose decimals are not known is not "known": amounts are then shown in base units, never guessed.
  const meta = (token: Address | "native"): KnownToken | null => {
    if (token === "native") return chain ? { symbol: chain.nativeCurrency.symbol, decimals: chain.nativeCurrency.decimals } : null;
    const read = tokens[tokenKey(chainId, token)];
    return read && typeof read.decimals === "number" && typeof read.symbol === "string" ? { symbol: read.symbol, decimals: read.decimals } : null;
  };
  /** An unlisted token is named by ADDRESS: anyone can deploy a token that calls itself USDC. */
  const tokenName = (token: Address | "native", listed: boolean | undefined): string => {
    const m = meta(token);
    if (token === "native" || listed !== false) return m?.symbol ?? token;
    return `unlisted token ${token}${m ? ` (calls itself ${m.symbol})` : ""}`;
  };
  const amountText = (token: Address | "native", amount: bigint, listed: boolean | undefined): string => {
    const m = meta(token);
    return m ? `${formatUnits(amount, m.decimals)} ${tokenName(token, listed)}` : `${amount.toString()} base units of ${token}`;
  };
  const spendMeta = spend ? meta(spend.token) : null;

  async function run(sign: () => Promise<Hex>) {
    if (busy || !armed) return;
    setBusy(true);
    setProblem(null);
    try {
      onSubmitted(await sign());
    } catch (err) {
      const error = toFrameError(err);
      // A refused rule (INVALID_PARAMS) is the user's to fix here; it is not reported to the app as a failed transaction.
      setProblem(error.code === ERR.LOCKED ? "Your passkey session has expired. Sign in again to continue." : error.message);
      if (error.code !== ERR.INVALID_PARAMS) onFailed(error);
    } finally {
      setBusy(false);
    }
  }

  function openScope() {
    if (!known || !armed || !session.address || !session.expiresAt) return;
    const draft = draftRule(known, { id: "draft", account: session.address, now: clock.now(), sessionExpiresAt: session.expiresAt });
    const decimals = spendMeta?.decimals ?? 0;
    setPerTx(spend ? formatUnits(draft.maxPerTx, decimals) : "");
    setPerDay(spend ? formatUnits(draft.maxPerDay, decimals) : "");
    setExpiry("session");
    setProblem(null);
    setMode("scope");
  }

  function saveAndSign() {
    if (!rpc || !known || !session.address || !session.expiresAt) return;
    const now = clock.now();
    let maxPerTx = 0n;
    let maxPerDay = 0n;
    if (spend) {
      if (!spendMeta) return setProblem("This token's decimals could not be read, so limits cannot be set. Use Allow once.");
      const tx = parseCap(perTx, spendMeta.decimals);
      const day = parseCap(perDay, spendMeta.decimals);
      if (tx === null) return setProblem(`Enter the limit per transaction as a plain number of ${spendMeta.symbol}.`);
      if (day === null) return setProblem(`Enter the limit per day as a plain number of ${spendMeta.symbol}.`);
      maxPerTx = tx;
      maxPerDay = day;
    }
    const persistent = expiry !== "session";
    const rule: Rule = {
      ...draftRule(known, { id: clock.id(), account: session.address, now, sessionExpiresAt: session.expiresAt }),
      maxPerTx,
      maxPerDay,
      persistent,
      sessionKey: persistent ? null : session.expiresAt,
      expiresAt: persistent ? now + (expiry === "7d" ? 7 : 30) * DAY_MS : session.expiresAt,
    };
    // allowAlways decodes the transaction AGAIN inside the wallet package and refuses a rule that does not describe it.
    void run(() => allowAlways(chainId, rpc, rule, { account: session.address!, expiresAt: session.expiresAt, now }));
  }

  const inert = disabled || !rpc || busy || !armed || decoded === undefined;
  // describeLines looks tokens up by bare lowercase address; this card keys them by chain, so strip the chain for it.
  const bareTokens = Object.fromEntries(Object.entries(tokens).filter(([key]) => key.startsWith(`${chainId}:`)).map(([key, value]) => [key.split(":")[1] ?? key, value]));
  const fallback = rpc && !known && !approval ? describeLines(chainId, describe(rpc), bareTokens) : [];
  const spenderName = approval ? `${protocolBrand(approval.protocol).name}'s ${approval.spenderKey.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()}` : null;

  return (
    <div className="flex flex-col gap-3.5">
      {replaced && (
        <p role="alert" data-testid="card-replaced" className="rounded-xl border border-[color:var(--m-warning-300)] bg-[color:var(--m-warning-100)] px-3 py-2 text-[13px] font-medium text-[color:var(--m-warning-700)] dark:border-[color:var(--m-warning-700)] dark:bg-[color:var(--m-warning-800)] dark:text-[color:var(--m-warning-300)]">
          This request changed while it was open. Read it again before you answer.
        </p>
      )}

      {decoded === undefined ? (
        <p className="text-[13px] text-[color:var(--m-text-secondary)]">Reading this request…</p>
      ) : known ? (
        <div className="flex flex-col gap-2">
          <p data-testid="card-title" className="text-[17px] font-semibold leading-snug text-[color:var(--m-text-primary)]">
            {words(known.action)} on {protocolBrand(known.protocol).name}
          </p>
          <dl className="flex flex-col gap-1.5 text-[13px]">
            {known.spend.map((s) => (
              <div key={`${s.token}`} className="flex justify-between gap-4">
                <dt className="text-[color:var(--m-text-secondary)]">Spends</dt>
                <dd data-testid="card-spend" className="break-all text-right font-dm-mono">
                  {amountText(s.token, s.amount, s.listed)}
                </dd>
              </div>
            ))}
            {known.receive && (
              <div className="flex justify-between gap-4">
                <dt className="text-[color:var(--m-text-secondary)]">Receives{known.receive.minAmount !== undefined ? " at least" : ""}</dt>
                <dd data-testid="card-receive" className="break-all text-right font-dm-mono">
                  {known.receive.minAmount !== undefined ? amountText(known.receive.token, known.receive.minAmount, known.receive.listed) : tokenName(known.receive.token, known.receive.listed)}
                </dd>
              </div>
            )}
            {known.details?.map((d) => (
              <div key={d.label} className="flex justify-between gap-4">
                <dt className="text-[color:var(--m-text-secondary)]">{d.label}</dt>
                <dd data-testid="card-detail" className="text-right">{d.value}</dd>
              </div>
            ))}
            {known.venue && (
              <div className="flex justify-between gap-4">
                <dt className="text-[color:var(--m-text-secondary)]">Pool and band</dt>
                <dd data-testid="card-venue" className="break-all text-right font-dm-mono">
                  {known.venue.pool} · band {known.venue.band}
                </dd>
              </div>
            )}
            <div className="flex justify-between gap-4">
              <dt className="text-[color:var(--m-text-secondary)]">Network</dt>
              <dd className="text-right">{chain?.name ?? `Chain ${chainId}`}</dd>
            </div>
          </dl>
          {!eligibility.eligible && <p className="text-[13px] text-[color:var(--m-text-secondary)]">{eligibility.reason}</p>}
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {fallback.map((line) => (
            <p key={line} className="break-all font-dm-mono text-[12px] leading-5 text-[color:var(--m-text-secondary)]">
              {line}
            </p>
          ))}
          {approval && rpc ? (
            <>
              {/* maxUint256 is "unlimited" to the decoder; any amount past what a token could ever hold is treated the same. */}
              {approval.unlimited || approval.amount >= UNLIMITED_FROM ? (
                <p data-testid="card-approval" className="text-[15px] font-semibold text-[color:var(--m-error-fg)]">
                  Allow {spenderName} to spend ALL of your {tokenName(approval.token, approval.listed !== false)}, with no limit and no expiry
                </p>
              ) : (
                <p data-testid="card-approval" className="text-[15px] font-semibold text-[color:var(--m-text-primary)]">
                  Allow {spenderName} to spend exactly {amountText(approval.token, approval.amount, approval.listed !== false)}
                </p>
              )}
              {"spender" in approval && typeof approval.spender === "string" && <p className="break-all font-dm-mono text-[12px] leading-5 text-[color:var(--m-text-secondary)]">{approval.spender}</p>}
              <p className="text-[13px] text-[color:var(--m-text-secondary)]">{approval.unlimited || approval.amount >= UNLIMITED_FROM ? "This contract could move every unit of this token you hold, now or later, until you revoke it." : "This contract may move up to this amount of this token, and nothing more."}</p>
            </>
          ) : (
            rpc && !eligibility.eligible && <p className="text-[13px] text-[color:var(--m-text-secondary)]">{eligibility.reason}</p>
          )}
        </div>
      )}

      {problem && (
        <p role="alert" data-testid="card-problem" className="text-[13px] text-[color:var(--m-error-fg)]">
          {problem}
        </p>
      )}

      {mode === "answer" ? (
        <div className="flex flex-wrap justify-end gap-2.5">
          <button type="button" data-testid="card-deny" disabled={busy} onClick={() => onFailed({ code: ERR.USER_REJECTED, message: "Denied in the wallet." })} className={BUTTON}>
            Deny
          </button>
          {eligibility.eligible && (
            <button type="button" data-testid="card-always" disabled={inert || !session.expiresAt} onClick={openScope} className={BUTTON}>
              Always allow…
            </button>
          )}
          <button type="button" data-testid="card-once" disabled={inert} onClick={() => rpc && void run(() => executeSigned(chainId, rpc))} className={PRIMARY}>
            {busy ? "Allow once…" : "Allow once"}
          </button>
        </div>
      ) : (
        <form
          className="flex flex-col gap-3.5 border-t border-[color:var(--m-border)] pt-3.5"
          onSubmit={(e) => {
            e.preventDefault();
            saveAndSign();
          }}
        >
          <div className="flex flex-col gap-1">
            <span className="text-sm font-semibold">
              Always allow {known ? words(known.action).toLowerCase() : "this"} on {known ? protocolBrand(known.protocol).name : "this protocol"}
              {spend ? ", within these limits" : ""}
            </span>
            <span className="text-[13px] text-[color:var(--m-text-secondary)]">Matching requests are signed without asking. Anything outside asks again. The rule is stored in this wallet, on this device.</span>
            {spend && (
              <span data-testid="scope-risk" className="text-[13px] text-[color:var(--m-text-secondary)]">
                A limit caps what goes in, not what comes back: the wallet does not know prices. Set the limit per day to the most you would accept losing in a day if something went wrong.
              </span>
            )}
          </div>
          {spend && spendMeta && (
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="scope-per-tx" className="text-[13px] font-medium">
                  Max per transaction, {spendMeta.symbol}
                </label>
                <input id="scope-per-tx" data-testid="scope-per-tx" inputMode="decimal" autoComplete="off" value={perTx} onChange={(e) => setPerTx(e.target.value)} className={FIELD} />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="scope-per-day" className="text-[13px] font-medium">
                  Max per day, {spendMeta.symbol}
                </label>
                <input id="scope-per-day" data-testid="scope-per-day" inputMode="decimal" autoComplete="off" value={perDay} onChange={(e) => setPerDay(e.target.value)} className={FIELD} />
              </div>
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="scope-expiry" className="text-[13px] font-medium">
              Expires
            </label>
            <select id="scope-expiry" data-testid="scope-expiry" value={expiry} onChange={(e) => setExpiry(e.target.value as Expiry)} className={FIELD.replace("font-dm-mono ", "")}>
              <option value="session">When this session ends</option>
              <option value="7d">In 7 days, kept after the session</option>
              <option value="30d">In 30 days, kept after the session</option>
            </select>
          </div>
          <div className="flex flex-wrap justify-end gap-2.5">
            <button type="button" disabled={busy} onClick={() => setMode("answer")} className={BUTTON}>
              Back
            </button>
            <button type="submit" data-testid="scope-save" disabled={inert} className={PRIMARY}>
              {busy ? "Saving…" : "Save rule and sign"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
