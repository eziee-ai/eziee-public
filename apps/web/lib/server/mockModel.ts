import { simulateReadableStream, type LanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { parsePrice, type AvailableModel } from "@repo/agent";

/**
 * A SCRIPTED model for end-to-end tests (spec §11: the mocked-model E2E isolates the
 * app from a real model's tool-calling quality). Used only when the server runs with
 * E2E_TEST_HOOKS=1 outside production; see `testHooksEnabled`. It changes what the
 * "model" says, nothing else: metering, the wallet and every check run for real.
 */


const usage = { inputTokens: { total: 1200, noCache: 1200, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 80, text: 80, reasoning: undefined } };
const finish = { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, logprobs: undefined, usage };
const toolFinish = { ...finish, finishReason: { unified: "tool-calls" as const, raw: undefined } };

const say = (text: string) => [{ type: "text-start" as const, id: "t" }, { type: "text-delta" as const, id: "t", delta: text }, { type: "text-end" as const, id: "t" }, finish];
const call = (toolName: string, input: unknown) => [{ type: "tool-call" as const, toolCallId: `call-${toolName}-${Math.random().toString(36).slice(2, 8)}`, toolName, input: JSON.stringify(input) }, toolFinish];

interface PromptMessage {
  role: string;
  content: unknown;
}

function lastUserText(prompt: PromptMessage[]): string {
  const user = [...prompt].reverse().find((m) => m.role === "user");
  const parts = Array.isArray(user?.content) ? (user.content as Array<{ type: string; text?: string }>) : [];
  return parts.map((p) => p.text ?? "").join(" ").toLowerCase();
}

function lastToolResult(prompt: PromptMessage[]): string | null {
  const last = prompt[prompt.length - 1];
  return last?.role === "tool" ? JSON.stringify(last.content) : null;
}

/** What the scripted model is billed as. The session's send floor reads it too, so the two agree in tests. */
export const MOCK_MODEL_INFO: AvailableModel = { id: "moonshotai/kimi-k3", label: "Kimi K3", isDefault: true, contextWindow: 256_000, price: parsePrice({ input: "0.000003", output: "0.000015" })! };

/**
 * A launch coin the scripted ladder buy trades. MADE UP: a mocked chain answers for it in end-to-end tests, and no
 * real chain holds anything at this address.
 */
export const MOCK_LAUNCH_COIN = "0x0000000000000000000000000000000000002001";

/** `tokens` are the token addresses the script trades, supplied by the caller so no real address lives in this file. */
export function mockModel(tokens: { base: string; quote: string; launchQuote: string }): { language: LanguageModel; info: AvailableModel } {
  const language = new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      const messages = prompt as unknown as PromptMessage[];
      const result = lastToolResult(messages);
      const text = lastUserText(messages);
      let chunks: ReturnType<typeof say> | ReturnType<typeof call>;
      if (result) chunks = say(result.includes('"denied"') ? "You denied that, so nothing was signed. I will not try again unless you ask." : result.includes('"confirmed"') ? "Done. That is confirmed onchain." : "Here is what I found.");
      // A swap trades the QUOTE token for the BASE token. "yesterday" asks for one priced from a stale quote,
      // which the fresh route is expected to refuse.
      else if (text.includes("swap at yesterday")) chunks = call("rate_swap", { tokenIn: tokens.quote, tokenOut: tokens.base, amountIn: "50", maxSlippageBps: 50, expectedOut: "50" });
      else if (text.includes("swap")) chunks = call("rate_swap", { tokenIn: tokens.quote, tokenOut: tokens.base, amountIn: "50", maxSlippageBps: 50 });
      else if (text.includes("place order")) chunks = call("rate_placeOrder", { side: "buy", base: tokens.base, quote: tokens.quote, price: "1.01", amount: "2" });
      else if (text.includes("picture")) chunks = say("Here it is: ![chart](https://collect.example/i?d=secret) and [the docs](https://example.com/docs).");
      else if (text.includes("fund my wallet")) chunks = call("openDeposit", {});
      else if (text.includes("add liquidity")) chunks = call("rate_addLiquidity", { base: tokens.base, quote: tokens.quote, band: 0, baseAmount: "1", quoteAmount: "2" });
      else if (text.includes("balances")) chunks = call("rate_balances", {});
      else if (text.includes("launch a coin")) chunks = call("rate_launch", { name: "eziee Demo", symbol: "DEMO", devBuy: "5", quote: tokens.launchQuote });
      else if (text.includes("buy demo")) chunks = call("rate_swap", { tokenIn: tokens.launchQuote, tokenOut: MOCK_LAUNCH_COIN, amountIn: "1", maxSlippageBps: 50 });
      else chunks = say("Hello from the scripted model.");
      // The two chunk shapes are both valid stream parts; their union is wider than the mock's parameter type can infer.
      return { stream: simulateReadableStream<unknown>({ chunks }) as never };
    },
  });
  return { language, info: MOCK_MODEL_INFO };
}
