import { costMicrousd, type BilledUsage, type ModelPrice } from "./pricing";

/**
 * The spending rule for one chat turn (spec §14.2).
 *
 * Credit is HELD before the model is called, and the account is charged at most
 * the hold. For that to be honest, the agent's tool loop must not be able to
 * cost more than the hold, and checking after a step is too late: the step that
 * crossed the line has already been paid for at the gateway. So the check is
 * made BEFORE each further step, against that step's worst case:
 *
 *   spent so far + cost(next prompt, the most the model may write) ≤ hold
 *
 * The next prompt is the last one plus what the model wrote plus what its tools
 * returned, which is exactly the text the next call will carry. Estimates here
 * err high. An over-estimate ends a loop a step early; an under-estimate spends
 * the operator's money.
 */

/** Tool results are JSON, which tokenizes worse than prose: two characters a token is a safe floor. */
const CHARS_PER_TOKEN_JSON = 2;
const CHARS_PER_TOKEN_TEXT = 3;
/** Framing a provider adds around each tool result. */
const TOOL_RESULT_OVERHEAD_TOKENS = 64;
/** A tool's JSON schema, which is sent with every call. Measured on this app's tools, rounded up. */
const TOOL_SCHEMA_TOKENS = 400;
const PROMPT_OVERHEAD_TOKENS = 500;

export interface BudgetStep {
  usage: BilledUsage;
  toolResults?: ReadonlyArray<{ output?: unknown }>;
}

const jsonLength = (value: unknown): number => {
  try {
    return (JSON.stringify(value) ?? "").length;
  } catch {
    // Not serialisable here, so its size is unknown: assume it is large rather than free.
    return 100_000;
  }
};

/** The size of the FIRST prompt: instructions, every tool's description and schema, and the conversation. */
export function estimatePromptTokens(input: { instructions: string; tools: Record<string, { description?: unknown }>; messages: unknown }): number {
  const tools = Object.values(input.tools).reduce((sum, tool) => sum + Math.ceil((typeof tool.description === "string" ? tool.description : "").length / CHARS_PER_TOKEN_TEXT) + TOOL_SCHEMA_TOKENS, 0);
  return PROMPT_OVERHEAD_TOKENS + Math.ceil(input.instructions.length / CHARS_PER_TOKEN_TEXT) + tools + Math.ceil(jsonLength(input.messages) / CHARS_PER_TOKEN_TEXT);
}

/** Tokens summed over the recorded calls. `inputTokens` already includes the cache reads. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

/** The same reading of a token count as the pricing math: absent, negative or not finite is none, and a fraction is rounded up. */
const tokens = (value: number | undefined): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.ceil(value) : 0);

export interface Budget {
  /** A stop condition for the tool loop: true when one more step might not fit in the hold. */
  shouldStop(steps: ReadonlyArray<BudgetStep>): boolean;
  /** Record one finished model call. Called for EVERY step, including a last one that no stop condition ever sees. */
  add(usage: BilledUsage): void;
  /** Real cost of the recorded steps, in micro-USD. */
  readonly spent: bigint;
  /** The tokens of the recorded steps. */
  usage(): TokenUsage;
  /** Whether this budget, rather than the model, ended the loop. */
  readonly stopped: boolean;
}

export function createBudget(input: { holdMicrousd: bigint; price: ModelPrice; marginBps: number; maxOutputTokens: number }): Budget {
  let spent = 0n;
  let stopped = false;
  const used: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  return {
    add(usage) {
      spent += costMicrousd(usage, input.price, input.marginBps);
      used.inputTokens += tokens(usage.inputTokens);
      used.outputTokens += tokens(usage.outputTokens);
      used.cacheReadTokens += tokens(usage.inputTokenDetails?.cacheReadTokens);
    },
    usage() {
      return { ...used };
    },
    shouldStop(steps) {
      // Summed from the steps themselves, so the decision does not depend on whether `add` has run for the last one yet.
      const soFar = steps.reduce((sum, step) => sum + costMicrousd(step.usage, input.price, input.marginBps), 0n);
      const last = steps[steps.length - 1];
      if (!last) return false;
      const returned = (last.toolResults ?? []).reduce((sum, result) => sum + Math.ceil(jsonLength(result.output) / CHARS_PER_TOKEN_JSON) + TOOL_RESULT_OVERHEAD_TOKENS, 0);
      const nextInputTokens = (last.usage.inputTokens ?? 0) + (last.usage.outputTokens ?? 0) + returned;
      const worstNext = costMicrousd({ inputTokens: nextInputTokens, outputTokens: input.maxOutputTokens }, input.price, input.marginBps);
      stopped = soFar + worstNext > input.holdMicrousd;
      return stopped;
    },
    get spent() {
      return spent;
    },
    get stopped() {
      return stopped;
    },
  };
}
