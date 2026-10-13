"use client";

import { Check, ExternalLink, Loader2, Plug, ShieldAlert, X } from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { cn } from "@repo/ui/cn";
import { WalletConfirmFrame } from "@/components/wallet/WalletConfirmFrame";
import { appChains } from "@/lib/chains";
import { answerAsk, useActionRun } from "@/lib/chat/actionRuns";
import type { ActionResult } from "@/lib/chat/runAction";
import { parseRankOutput } from "@/lib/chat/rankOutput";
import { protocolBrand } from "@/lib/protocols/brand";
import { CheckDraw, StepProgress, sawRunLive } from "./motion";
import { RankTable } from "./RankTable";

/** The fields every tool part carries, read generically: the tool set is built per request, so its types cannot be named here. */
export interface ToolPartLike {
  type: string;
  toolCallId: string;
  state: "input-streaming" | "input-available" | "approval-requested" | "approval-responded" | "output-available" | "output-error" | "output-denied";
  input?: unknown;
  output?: unknown;
  errorText?: string;
}

function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex flex-col gap-3 rounded-2xl border border-[color:var(--m-border)] bg-[color:var(--m-surface)] p-4", className)}>{children}</div>;
}

function Pill({ tone, children }: { tone: "ok" | "warn" | "err" | "info"; children: ReactNode }) {
  return (
    <span
      className={cn(
        "motion-color inline-flex min-h-[26px] items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-xs font-semibold",
        tone === "ok" && "bg-[color:var(--m-surface-success)] text-[color:var(--m-on-surface-success)]",
        tone === "info" && "bg-[color:var(--m-surface-selected)] text-[color:var(--m-on-surface-selected)]",
        tone === "warn" && "bg-[color:var(--m-warning-100)] text-[color:var(--m-warning-700)] dark:bg-[color:var(--m-warning-800)] dark:text-[color:var(--m-warning-300)]",
        tone === "err" && "bg-[color:var(--m-error-100)] text-[color:var(--m-error-600)] dark:bg-[color:var(--m-error-800)] dark:text-[color:var(--m-error-300)]",
      )}
    >
      {children}
    </span>
  );
}

/** "rate_placeOrder" → "Place order on Rate": the protocol by its shown name, never its internal id. */
export function actionTitle(toolName: string): string {
  const [protocol = "", action = ""] = toolName.split("_");
  const words = actionWords(action);
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} on ${protocolBrand(protocol).name}`;
}

/** "placeOrder" → "place order". */
function actionWords(action: string): string {
  return action.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
}

/** The protocol's mark and name, then what was read: "[mark] Rate · tokens". */
function ToolLabel({ toolName, running }: { toolName: string; running: boolean }) {
  const [protocol = "", action = ""] = toolName.split("_");
  const brand = protocolBrand(protocol);
  return (
    <span className="flex items-center gap-1.5">
      {brand.logo ? <img src={brand.logo} alt="" aria-hidden width={16} height={16} className="h-4 w-4 shrink-0 rounded-[4px]" /> : <Plug aria-hidden className="h-3.5 w-3.5 shrink-0" />}
      <span className={cn("font-medium text-[color:var(--m-text-primary)]", running && "shimmer")}>{brand.name}</span>
      <span aria-hidden>·</span>
      <span className={cn(running && "shimmer")}>{actionWords(action)}</span>
    </span>
  );
}

/* ------------------------------ reads ------------------------------ */

interface QuoteOutput {
  available?: boolean;
  amountIn?: string;
  estimatedOut?: string;
  priceImpactPct?: number;
  reason?: string;
  hops?: Array<{ pair: string }>;
  tokenIn?: QuoteToken;
  tokenOut?: QuoteToken;
}

interface QuoteToken {
  symbol: string | null;
  /** On Rate's reviewed list. An unlisted token's symbol is whatever its contract says, so it can claim to be anything. */
  listed?: boolean;
}

/** A ticker as shown: an unlisted token's own claim is marked, so a fake "USDC" never reads as the real one. */
function tickerText(token: QuoteToken | undefined): string {
  if (!token?.symbol) return "";
  return token.listed ? token.symbol : `${token.symbol} (unlisted)`;
}

function Ticker({ token }: { token: QuoteToken | undefined }) {
  if (!token?.symbol) return null;
  return (
    <>
      <span className="font-semibold">{token.symbol}</span>
      {!token.listed && <span className="ml-1.5 rounded-full border border-[color:var(--m-warning-300)] px-1.5 align-middle text-[11px] font-semibold text-[color:var(--m-warning-700)] dark:text-[color:var(--m-warning-300)]">Unlisted</span>}
    </>
  );
}

/** At most six significant digits, so a gateway's 0.004999999999999999 reads 0.005. */
function readable(value: string | undefined): string {
  const n = Number(value);
  return value === undefined || !Number.isFinite(n) ? (value ?? "") : new Intl.NumberFormat("en-US", { maximumSignificantDigits: 6 }).format(n);
}

/** The quote tool's input, if it is the shape the tool takes: plain decimal amount, two addresses. */
function quoteInput(input: unknown): { amountIn: string; tokenIn: string; tokenOut: string } | null {
  if (typeof input !== "object" || input === null) return null;
  const { amountIn, tokenIn, tokenOut } = input as Record<string, unknown>;
  const address = /^0x[0-9a-fA-F]{40}$/;
  if (typeof amountIn !== "string" || !/^\d{1,30}(\.\d{1,30})?$/.test(amountIn)) return null;
  if (typeof tokenIn !== "string" || !address.test(tokenIn) || typeof tokenOut !== "string" || !address.test(tokenOut)) return null;
  return { amountIn, tokenIn, tokenOut };
}

export function ReadToolPart({ part, toolName, onAsk }: { part: ToolPartLike; toolName: string; /** Sends a follow-up as the person; absent while the chat cannot take one. */ onAsk?: (text: string) => void }) {
  const running = part.state === "input-streaming" || part.state === "input-available";
  const failed = part.state === "output-error" || (typeof part.output === "object" && part.output !== null && "error" in part.output);
  const quote = toolName.endsWith("_quote") && part.state === "output-available" && !failed ? (part.output as QuoteOutput) : null;
  const rank = toolName.endsWith("_rank") && part.state === "output-available" && !failed ? parseRankOutput(part.output) : null;
  // The follow-up is built from what was ASKED (the tool's own input), never from the gateway's echo of it: an answer
  // naming a larger amount must not become the person's next request.
  const asked = quote ? quoteInput(part.input) : null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-[13px] text-[color:var(--m-text-secondary)]">
        {running ? <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> : failed ? <X aria-hidden className="h-3.5 w-3.5 text-[color:var(--m-error-fg)]" /> : <Check aria-hidden className="h-3.5 w-3.5 text-[color:var(--m-success-fg)]" />}
        <ToolLabel toolName={toolName} running={running} />
        <span>{running ? "reading" : failed ? "could not be read" : "read"}</span>
      </div>
      {quote?.available && (
        <Card>
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-semibold">Quote</span>
            <span className="text-xs text-[color:var(--m-text-secondary)]">Estimated, not a guarantee</span>
          </div>
          <dl className="grid grid-cols-2 gap-3 text-[13px]">
            <div className="flex flex-col">
              <dt className="text-xs text-[color:var(--m-text-secondary)]">You pay</dt>
              <dd className="text-lg"><span className="font-dm-mono">{readable(quote.amountIn)}</span> <Ticker token={quote.tokenIn} /></dd>
            </div>
            <div className="flex flex-col">
              <dt className="text-xs text-[color:var(--m-text-secondary)]">You receive, estimated</dt>
              <dd className="text-lg"><span className="font-dm-mono">≈ {readable(quote.estimatedOut)}</span> <Ticker token={quote.tokenOut} /></dd>
            </div>
          </dl>
          <div className="flex justify-between gap-4 text-[13px] text-[color:var(--m-text-secondary)]">
            <span>{quote.hops?.map((h) => h.pair).join(" → ")}</span>
            {typeof quote.priceImpactPct === "number" && <span className="font-dm-mono">Price impact {quote.priceImpactPct}%</span>}
          </div>
          {onAsk && asked && quote.tokenIn?.symbol && quote.tokenOut?.symbol && (
            <div className="flex flex-wrap gap-2 pt-1">
              {/* Sends the request to the chat: the swap is built from a FRESH quote and the wallet still asks. */}
              <button type="button" data-testid="quote-swap" onClick={() => onAsk(`Swap ${asked.amountIn} ${tickerText(quote.tokenIn)} (${asked.tokenIn}) for ${tickerText(quote.tokenOut)} (${asked.tokenOut})`)} className="min-h-10 rounded-full bg-[color:var(--m-primary)] px-4 text-sm font-semibold text-[color:var(--m-on-primary)] motion-press hover:bg-[color:var(--m-primary-hover)]">
                Swap {asked.amountIn} {tickerText(quote.tokenIn)} for {tickerText(quote.tokenOut)}
              </button>
              <button type="button" data-testid="quote-other" onClick={() => onAsk("Show available markets")} className="min-h-10 rounded-full border border-[color:var(--m-border)] px-4 text-sm font-semibold hover:bg-[color:var(--m-surface-2)]">
                Quote another pair
              </button>
            </div>
          )}
        </Card>
      )}
      {rank && (<Card><RankTable rank={rank} /></Card>)}
    </div>
  );
}

/* ------------------------------ actions ------------------------------ */

function explorerTx(chainId: number, hash: string): string | null {
  const base = appChains.find((c) => c.id === chainId)?.blockExplorers?.default.url.replace(/\/$/, "");
  return base ? `${base}/tx/${hash}` : null;
}

function Hashes({ chainId, hashes }: { chainId: number; hashes: readonly string[] }) {
  if (hashes.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1.5">
      {hashes.map((hash) => {
        const href = explorerTx(chainId, hash);
        return (
          <li key={hash} className="flex flex-wrap items-center justify-between gap-2">
            <code className="break-all font-dm-mono text-xs">{hash}</code>
            {href && (
              <a href={href} target="_blank" rel="noreferrer" className="flex min-h-11 items-center gap-1 text-[13px] font-medium text-[color:var(--m-primary-fg)] underline underline-offset-2">
                Explorer <ExternalLink aria-hidden className="h-3 w-3" />
              </a>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function ResultCard({ title, chainId, result, live = false }: { title: string; chainId: number; result: ActionResult; /** It finished in this view, so a confirmation draws its check; from history it is only shown. */ live?: boolean }) {
  const tone = result.status === "confirmed" ? "ok" : result.status === "denied" || result.status === "unfilled" ? "info" : "err";
  const label = { confirmed: "Confirmed", unfilled: "Nothing filled", denied: "Denied", reverted: "Reverted", failed: "Not sent" }[result.status];
  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-semibold">{title}</span>
        <Pill tone={tone}>
          {result.status === "confirmed" && <CheckDraw animate={live} />}
          {label}
        </Pill>
      </div>
      {result.status === "denied" && <p className="text-sm text-[color:var(--m-text-secondary)]">You denied this in your wallet. Nothing was signed.</p>}
      {result.message && <p className="text-sm text-[color:var(--m-text-secondary)]">{result.message}</p>}
      {result.facts && (
        <dl className="flex flex-col gap-1 text-[13px]">
          {Object.entries(result.facts).map(([label, value]) => (
            <div key={label} className="flex justify-between gap-4">
              <dt className="text-[color:var(--m-text-secondary)]">{label}</dt>
              <dd data-testid="result-fact" className="break-all text-right font-dm-mono">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      <Hashes chainId={chainId} hashes={result.hashes} />
    </Card>
  );
}

export function ActionToolPart({ part, toolName, fallbackChainId }: { part: ToolPartLike; toolName: string; /** For a result loaded from history, where the run's own network is not known. */ fallbackChainId: number }) {
  const run = useActionRun(part.toolCallId);
  const [sawLive, setSawLive] = useState(false);
  // Adjusting state from what this render sees (React's documented pattern), so the flag holds before any result renders.
  if (sawRunLive(sawLive, run?.phase) !== sawLive) setSawLive(true);
  const live = sawRunLive(sawLive, run?.phase);
  const title = actionTitle(toolName);
  // Links go to the explorer of the network the action RAN on, not whichever is selected now.
  const chainId = run?.chainId ?? fallbackChainId;

  if (part.state === "output-available") return <ResultCard title={title} chainId={(part.output as ActionResult).chainId ?? chainId} result={part.output as ActionResult} live={live} />;
  if (part.state === "output-error") return <ResultCard title={title} chainId={chainId} result={{ status: "failed", hashes: [], message: part.errorText ?? "The action failed." }} />;
  if (part.state === "input-streaming") return <p className="text-[13px] text-[color:var(--m-text-secondary)]">Preparing {title.toLowerCase()}…</p>;

  // Finished here, but the result never reached the transcript (the chat was left while it ran). Show what happened.
  if (run?.phase === "done" && run.result) return <ResultCard title={title} chainId={chainId} result={run.result} live={live} />;

  // A tool call with no live run is history (a reload, another tab). It is NEVER run from here.
  if (!run) {
    return (
      <Card>
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-semibold">{title}</span>
          <Pill tone="info">Not completed</Pill>
        </div>
        <p className="text-sm text-[color:var(--m-text-secondary)]">This action was interrupted before its result was recorded here. Nothing more will happen on its own, but a transaction that was already signed may still have gone through. Check your balances or open orders before asking again.</p>
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-semibold">{title}</span>
        {run.phase === "asking" ? (
          <Pill tone="warn">
            <ShieldAlert aria-hidden className="h-3.5 w-3.5" /> Needs your approval
          </Pill>
        ) : (
          <Pill tone="info">
            <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> {run.phase === "confirming" ? "Confirming" : run.phase === "queued" ? "Waiting for the action before it" : "Preparing"}
          </Pill>
        )}
      </div>
      <StepProgress phase={run.phase} />
      {run.total > 1 && (
        <p className="text-[13px] text-[color:var(--m-text-secondary)]">
          Step {run.index + 1} of {run.total}
          {run.total === 2 && run.index === 0 ? ": an approval for the exact amount, then the action itself." : "."}
        </p>
      )}
      {run.ask && (
        <div className="flex flex-col gap-2 rounded-xl border border-[color:var(--m-border)] bg-[color:var(--m-background)] p-3">
          <p className="text-xs text-[color:var(--m-text-secondary)]">Drawn by your wallet from the transaction itself, not from this chat.</p>
          <WalletConfirmFrame
            chainId={run.ask.chainId}
            rpc={run.ask.rpc}
            label="Allow once"
            variant="card"
            onSubmitted={(hash) => answerAsk(part.toolCallId, { kind: "submitted", hash })}
            onFailed={(error) => answerAsk(part.toolCallId, error.code === 4001 ? { kind: "denied" } : { kind: "failed", message: error.message })}
          />
          {/* If the wallet's card cannot be shown or answered, this is the way out: it counts as a denial. */}
          <button type="button" data-testid="action-cancel" onClick={() => answerAsk(part.toolCallId, { kind: "denied" })} className="min-h-11 self-start rounded-xl px-3 text-[13px] font-medium text-[color:var(--m-text-secondary)] underline underline-offset-2 hover:text-[color:var(--m-text-primary)]">
            Cancel this action
          </button>
        </div>
      )}
      <Hashes chainId={chainId} hashes={run.hashes} />
    </Card>
  );
}

/* ------------------------------ 402 ------------------------------ */

export function TopUpCard({ spendable, rails }: { spendable: string; rails: string[] }) {
  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-semibold">Add credit to continue</span>
        <Pill tone="warn">Out of credit</Pill>
      </div>
      <p className="text-sm text-[color:var(--m-text-secondary)]">Your message was not sent to the model and nothing was charged. Spendable credit: {spendable}.</p>
      {rails.length === 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-4">
          <p data-testid="topup-no-rails" className="max-w-[560px] text-sm text-[color:var(--m-text-secondary)]">
            Add usage credit with a hosted checkout. Stripe is the planned payment rail; crypto-enabled methods depend on the connected Stripe account and region.
          </p>
          <Link href="/settings/credit" className="flex min-h-11 items-center self-start rounded-xl bg-[color:var(--m-primary)] px-4 text-sm font-semibold text-[color:var(--m-on-primary)] hover:bg-[color:var(--m-primary-hover)]">
            Pay for credit
          </Link>
        </div>
      ) : (
        <Link href="/settings/credit" className="flex min-h-11 items-center self-start rounded-xl bg-[color:var(--m-primary)] px-4 text-sm font-semibold text-[color:var(--m-on-primary)] hover:bg-[color:var(--m-primary-hover)]">
          Add credit
        </Link>
      )}
    </Card>
  );
}
