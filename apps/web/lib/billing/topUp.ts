import { formatUnits } from "viem";
import { formatUsd } from "@repo/agent/pricing";
import { validateAmount, type AmountCheck } from "@/lib/transfer/withdrawForm";

/**
 * Everything that can be wrong with a USDC top-up BEFORE the wallet is asked. The cap is checked here, not only on
 * the server: there it can only refuse to credit money that has already been sent.
 */
export function checkTopUp(input: string, token: { decimals: number; held: bigint | undefined; maxMicrousd: bigint; /** USDC unless said. */ symbol?: string; /** Credit one whole token buys; one dollar (USDC) unless said. */ microusdPerToken?: bigint }): AmountCheck {
  const symbol = token.symbol ?? "USDC";
  const amount = validateAmount(input, { symbol, decimals: token.decimals });
  if (!amount.ok) return amount;
  // The cap is in dollars of credit; in base units of the token it is cap × 10^decimals ÷ price.
  const capUnits = (token.maxMicrousd * 10n ** BigInt(token.decimals)) / (token.microusdPerToken ?? 1_000_000n);
  // Credit is counted in micro-dollars, rounded down: an amount worth less than one buys nothing and is refused.
  if ((amount.amount * (token.microusdPerToken ?? 1_000_000n)) / 10n ** BigInt(token.decimals) === 0n) return { ok: false, message: `That is too little ${symbol} to buy any credit.` };
  if (amount.amount > capUnits) return { ok: false, message: `The most one top-up can be credited for here is ${formatUsd(token.maxMicrousd)}. Send less, or send it in parts.` };
  if (token.held !== undefined && amount.amount > token.held) return { ok: false, message: `This wallet holds ${formatUnits(token.held, token.decimals)} ${symbol} on this network.` };
  return amount;
}

/**
 * Whether the wallet must receive USDC before it can pay: "empty" when it holds none, "short" when it holds less
 * than a valid amount. Quiet while the balance is unknown, and for an amount that is wrong for another reason.
 */
export function depositNeeded(input: string, token: Parameters<typeof checkTopUp>[1]): "empty" | "short" | null {
  if (token.held === undefined) return null;
  if (token.held === 0n) return "empty";
  const check = checkTopUp(input, { ...token, held: undefined });
  return check.ok && check.amount > token.held ? "short" : null;
}

/** After this long with no receipt, a deposit is probably not coming: say so, and ask less often. */
export const STALE_AFTER_MS = 10 * 60_000;
const BASE_MS = 4_000;
const SLOW_MS = 30_000;
const MAX_MS = 60_000;

/** How soon to ask about a deposit again; `false` once it is settled. Failures back off, and a server's Retry-After is obeyed. */
export function pollDelayMs(state: { settled: boolean; failures: number; ageMs: number; retryAfterSeconds?: number }): number | false {
  if (state.settled) return false;
  if (state.retryAfterSeconds !== undefined && state.retryAfterSeconds > 0) return Math.min(state.retryAfterSeconds * 1000, 5 * 60_000);
  if (state.failures > 0) return Math.min(BASE_MS * 2 ** state.failures, MAX_MS);
  return state.ageMs > STALE_AFTER_MS ? SLOW_MS : BASE_MS;
}
