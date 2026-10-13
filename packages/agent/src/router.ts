import { RANK_MEASURES, type RankMeasure } from "@repo/protocols/types";
import { z } from "zod";

/**
 * Reads ONE user message into two typed answers with TypeSafe's Jev: what the person wants, and by which measure
 * they want markets compared. It is a predictor of the read the model would have asked for, nothing more: it never
 * sees an address, the history or market data, never picks a market and never touches a transaction. Every failure
 * is `null`, which means "carry on as if this did not exist".
 */

const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL = "jev-latest";
const MAX_MESSAGE_CHARS = 2_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
export const ROUTER_TIMEOUT_MS = 1_500;
/** The spike's one misread sat at 0.73 to 0.86; every correct reading but one sat at or near 1.00. */
export const ROUTER_GATE = 0.9;

export const ROUTER_INTENTS = ["buy_asset", "provide_liquidity", "swap_specific", "account_info", "market_info", "unclear"] as const;
export type RouterIntent = (typeof ROUTER_INTENTS)[number];
const UNSPECIFIED = "unspecified";

export interface Reading { intent: RouterIntent; intentConfidence: number; measure: RankMeasure | typeof UNSPECIFIED; measureConfidence: number; model: string; usage: { inputTokens: number; outputTokens: number }; ms: number }
export type RouterFetch = (input: string, init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal; redirect: "error" }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const QUESTIONS = {
  intent: {
    type: "choice",
    instructions: "What does the person in `message` want to do?",
    criteria: {
      buy_asset: "Wants help choosing a token to buy, without naming the token and amount themselves.",
      provide_liquidity: "Wants to provide liquidity / LP / earn yield or APY from a pool.",
      swap_specific: "Names the exact tokens (and usually an amount) to swap; no choosing needed.",
      account_info: "Asks about their own balances, orders or positions.",
      market_info: "Asks for prices or market facts with no wish to buy or LP.",
      unclear: "Too vague or off-topic to tell.",
    } satisfies Record<RouterIntent, string>,
  },
  measure: {
    type: "choice",
    instructions: "By which measure does the person in `message` want markets compared?",
    criteria: {
      highest_yield: "Highest APY / APR / yield / fee return.",
      deepest_liquidity: "Deepest or largest pool, most TVL.",
      most_traded: "Most volume or trading activity.",
      weekly_momentum: "Rising fastest recently; pumping; trending up.",
      monthly_dip: "Fallen the most; buying the dip.",
      lowest_risk: "Safest, most stable, least volatile.",
      unspecified: "No measure stated, or a bare 'best'.",
    } satisfies Record<RankMeasure | typeof UNSPECIFIED, string>,
  },
} as const;

const confidence = z.number().min(0).max(1);
const responseSchema = z.object({
  model: z.string().max(100),
  answers: z.object({
    intent: z.object({ choice: z.enum(ROUTER_INTENTS), confidence }),
    measure: z.object({ choice: z.enum([...RANK_MEASURES, UNSPECIFIED]), confidence }),
  }),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }),
});

export async function readRequest(input: { message: string; apiKey: string; fetch?: RouterFetch; timeoutMs?: number; signal?: AbortSignal }): Promise<Reading | null> {
  const message = input.message.trim().slice(0, MAX_MESSAGE_CHARS);
  if (!message) return null;
  const doFetch: RouterFetch = input.fetch ?? ((url, init) => fetch(url, init));
  const started = performance.now();
  try {
    const timeout = AbortSignal.timeout(input.timeoutMs ?? ROUTER_TIMEOUT_MS);
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    const response = await doFetch(JEV_URL, { method: "POST", redirect: "error", signal, headers: { authorization: `Bearer ${input.apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ model: JEV_MODEL, state: { message }, questions: QUESTIONS }) });
    if (!response.ok) throw new Error(`status ${response.status}`);
    const text = await response.text();
    if (new TextEncoder().encode(text).length > MAX_RESPONSE_BYTES) throw new Error("response too large");
    const parsed = responseSchema.parse(JSON.parse(text));
    return { intent: parsed.answers.intent.choice, intentConfidence: parsed.answers.intent.confidence, measure: parsed.answers.measure.choice, measureConfidence: parsed.answers.measure.confidence, model: parsed.model, usage: { inputTokens: parsed.usage.input_tokens, outputTokens: parsed.usage.output_tokens }, ms: Math.round(performance.now() - started) };
  } catch (error) {
    // The kind of failure only: never the message, the key, or what the far side said.
    let reason: string;
    if (error instanceof z.ZodError) reason = "unexpected response shape";
    else if (error instanceof SyntaxError) reason = "response was not JSON";
    else if (error instanceof Error && /^status \d+$|too large/.test(error.message)) reason = error.message;
    else reason = "request failed or timed out";
    console.warn(`[router] no reading: ${reason}`);
    return null;
  }
}

const PRERUN_INTENTS: ReadonlySet<RouterIntent> = new Set(["buy_asset", "provide_liquidity"]);

/** A pre-run needs a buy or LP request, a measure the person actually stated, and both answers over the gate. */
export function decidePrerun(reading: Reading | null): { measure: RankMeasure } | null {
  if (!reading || !PRERUN_INTENTS.has(reading.intent) || reading.measure === UNSPECIFIED) return null;
  if (reading.intentConfidence < ROUTER_GATE || reading.measureConfidence < ROUTER_GATE) return null;
  return { measure: reading.measure };
}
