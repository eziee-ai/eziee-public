/**
 * Metering math (spec §14.2). Integers only: money is micro-USD (1e-6 USD) and a
 * price per token is pico-USD (1e-12 USD), because real prices are fractions of
 * a micro-dollar (0.57 µUSD per token) and a float would lose them.
 *
 * INVARIANT: every rounding is UP. Rounding down would serve some requests free.
 * INVARIANT: a model without a parseable, positive price is refused, never
 * served unmetered.
 */

const PICO_PER_USD_DIGITS = 12;
const PICO_PER_MICRO = 1_000_000n;
const BPS = 10_000n;

export interface ModelPrice {
  inputPico: bigint;
  outputPico: bigint;
  cacheReadPico: bigint;
  cacheWritePico: bigint;
}

/** The part of the AI SDK's usage object that is billed. */
export interface BilledUsage {
  inputTokens?: number;
  outputTokens?: number;
  inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
}

/** "0.00000057" USD per token → 570000 pico-USD. Plain decimals only; anything else is not a price. */
function toPico(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^\d+(\.\d+)?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > PICO_PER_USD_DIGITS && /[1-9]/.test(fraction.slice(PICO_PER_USD_DIGITS))) return null; // finer than a pico-dollar: not representable, so not trusted
  return BigInt(whole!) * 10n ** BigInt(PICO_PER_USD_DIGITS) + BigInt(fraction.slice(0, PICO_PER_USD_DIGITS).padEnd(PICO_PER_USD_DIGITS, "0"));
}

/** The gateway's `pricing` object for a model, or null when it cannot be billed from. */
export function parsePrice(raw: unknown): ModelPrice | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const inputPico = toPico(record.input);
  const outputPico = toPico(record.output);
  if (inputPico === null || outputPico === null || inputPico <= 0n || outputPico <= 0n) return null;
  // A cache price that is absent is charged as plain input: never cheaper than listed, never free.
  return { inputPico, outputPico, cacheReadPico: toPico(record.input_cache_read) ?? inputPico, cacheWritePico: toPico(record.input_cache_write) ?? inputPico };
}

const count = (value: number | undefined): bigint => (typeof value === "number" && Number.isFinite(value) && value > 0 ? BigInt(Math.ceil(value)) : 0n);
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

/** What a finished request costs the user, in micro-USD: real usage at gateway prices, plus the margin, rounded up. */
export function costMicrousd(usage: BilledUsage, price: ModelPrice, marginBps: number): bigint {
  const cacheRead = count(usage.inputTokenDetails?.cacheReadTokens);
  const cacheWrite = count(usage.inputTokenDetails?.cacheWriteTokens);
  const input = count(usage.inputTokens);
  // `inputTokens` is the total; what is neither read from nor written to cache is fresh input.
  const fresh = input > cacheRead + cacheWrite ? input - cacheRead - cacheWrite : 0n;
  const pico = fresh * price.inputPico + cacheRead * price.cacheReadPico + cacheWrite * price.cacheWritePico + count(usage.outputTokens) * price.outputPico;
  return ceilDiv(pico * (BPS + BigInt(marginBps)), BPS * PICO_PER_MICRO);
}

/**
 * What to reserve BEFORE calling the model: the worst case for `maxSteps` model calls at the first prompt's
 * size. The budget (budget.ts) then refuses to start any step whose worst case would not fit in what is left,
 * which is what keeps a request from costing more than was held.
 */
export function holdMicrousd(price: ModelPrice, input: { estimatedInputTokens: number; maxOutputTokens: number; maxSteps: number; marginBps: number; minimum: bigint }): bigint {
  const perStep = costMicrousd({ inputTokens: input.estimatedInputTokens, outputTokens: input.maxOutputTokens }, price, input.marginBps);
  const total = perStep * BigInt(Math.max(1, input.maxSteps));
  return total > input.minimum ? total : input.minimum;
}

/** Micro-USD as dollars for display: "$0.0042". Never used for arithmetic. */
export function formatUsd(micro: bigint): string {
  const negative = micro < 0n;
  const abs = negative ? -micro : micro;
  const dollars = abs / PICO_PER_MICRO;
  const fraction = (abs % PICO_PER_MICRO).toString().padStart(6, "0");
  // Two places for whole cents and above; up to four when the amount is smaller than a cent.
  const places = abs >= 10_000n ? 2 : 4;
  return `${negative ? "-" : ""}$${dollars}.${fraction.slice(0, places)}`;
}
