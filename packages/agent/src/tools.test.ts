import { generateText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { PublicClient } from "viem";
import { describe, expect, it } from "vitest";
import { createRateAdapter } from "@repo/protocols/rate";
import { systemPrompt } from "./prompt";
import { buildTools, clientToolNames } from "./tools";

const ARC = 5042002;
const ACCOUNT = "0x0000000000000000000000000000000000001001";
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };

function rate(body: unknown = { pairs: [], totalCount: 0, totalPages: 0 }) {
  return createRateAdapter({ fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) });
}
const ctx = { chainId: ARC, account: ACCOUNT as `0x${string}`, client: {} as PublicClient };

describe("buildTools", () => {
  it("offers a server tool per read, a client tool per action, and the app tools", () => {
    const adapter = rate();
    const tools = buildTools({ adapters: [adapter], ctx });
    const reads = ["tokens", ...Object.keys(adapter.reads)].map((name) => `rate_${name}`);
    const actions = Object.keys(adapter.actions).map((name) => `rate_${name}`);
    const app = ["getWalletStatus", "openDeposit", "openWithdraw"];
    // Exactly these, whatever the adapter grows: nothing unnamed is offered to the model.
    expect(Object.keys(tools).sort()).toEqual([...reads, ...actions, ...app].sort());
    expect(actions).toEqual(expect.arrayContaining(["rate_swap", "rate_placeOrder", "rate_cancelOrder"]));
    // Reads run on the server; actions and app tools have no execute, so only the browser can answer them.
    for (const name of reads) expect(typeof tools[name]!.execute, name).toBe("function");
    for (const name of [...actions, ...app]) expect(tools[name]!.execute, name).toBeUndefined();
    const names = clientToolNames([adapter]);
    expect(names.actions.rate_swap).toEqual({ protocol: "rate", action: "swap" });
    expect(Object.keys(names.actions).sort()).toEqual([...actions].sort());
    expect(names.app).toEqual(app);
  });

  it("shows the model the JSON Schema of a protocol that describes its own inputs, for reads and actions alike", async () => {
    const schema = { type: "object", properties: { amountIn: { type: "string", description: "whole tokens" } }, required: ["amountIn"] };
    const base = rate();
    const mcpLike = { ...base, id: "fixture", actions: { swap: { ...base.actions.swap!, intentJsonSchema: schema } }, reads: { quote: { ...base.reads.quote!, inputJsonSchema: schema } } };
    const tools = buildTools({ adapters: [mcpLike], ctx });
    for (const name of ["fixture_swap", "fixture_quote"]) {
      const shown = await (tools[name]!.inputSchema as { jsonSchema: unknown | PromiseLike<unknown> }).jsonSchema;
      expect(shown, name).toMatchObject({ required: ["amountIn"], properties: { amountIn: { description: "whole tokens" } } });
    }
  });

  it("offers no protocol tools on a network the protocol is not on", () => {
    expect(Object.keys(buildTools({ adapters: [rate()], ctx: { ...ctx, chainId: 1 } })).sort()).toEqual(["getWalletStatus", "openDeposit", "openWithdraw"]);
  });

  it("hands the model usable JSON schemas, including for intents that carry refinements", async () => {
    let seen: Array<{ name: string; inputSchema: { properties?: Record<string, unknown>; required?: string[] } }> = [];
    await generateText({
      model: new MockLanguageModelV4({
        doGenerate: async (options) => {
          seen = (options.tools ?? []) as typeof seen;
          return { content: [{ type: "text", text: "ok" }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] };
        },
      }),
      tools: buildTools({ adapters: [rate()], ctx }),
      prompt: "hi",
    });
    const swap = seen.find((t) => t.name === "rate_swap")!;
    expect(Object.keys(swap.inputSchema.properties ?? {}).sort()).toEqual(["amountIn", "expectedOut", "maxSlippageBps", "tokenIn", "tokenOut"]);
    expect(swap.inputSchema.required?.sort()).toEqual(["amountIn", "maxSlippageBps", "tokenIn", "tokenOut"]);
  });

  it("runs a read with the SESSION's chain and account, and returns a failure as data rather than throwing", async () => {
    const tools = buildTools({ adapters: [rate({ unexpected: true })], ctx });
    const out = await tools.rate_pools!.execute!({}, { toolCallId: "t", messages: [] } as never);
    expect(out).toEqual({ error: { code: "TEMPORARILY_UNAVAILABLE", message: expect.any(String) } });
    const bad = await tools.rate_quote!.execute!({ tokenIn: "nope", tokenOut: "nope", amountIn: "1" }, { toolCallId: "t", messages: [] } as never);
    expect(bad).toMatchObject({ error: { code: "INVALID_INTENT" } });
  });

  it("lists the reviewed tokens without a network call", async () => {
    const out = (await buildTools({ adapters: [rate()], ctx }).rate_tokens!.execute!({}, { toolCallId: "t", messages: [] } as never)) as { tokens: Array<{ symbol: string }> };
    expect(out.tokens.map((t) => t.symbol)).toEqual(["USDC", "EURC"]);
  });

  it("offers a protocol's rank read to the model as a server tool", () => {
    const tools = buildTools({ adapters: [createRateAdapter()], ctx: { chainId: 5042002, client: {} as never } });
    expect(tools.rate_rank).toBeDefined();
    expect("execute" in tools.rate_rank!).toBe(true);
  });

  it("tells the model to use a rank read to compare markets", () => {
    expect(systemPrompt({ brand: "x", chainName: "Arc", chainId: 1, account: null, protocols: [], nativeSymbol: "USDC" })).toMatch(/rank read/);
  });
});

describe("tool schemas as the model API receives them", () => {
  it.each([5042002, 11155931, 10143])("carry no regex the APIs reject (no \\p{…} Unicode classes) on chain %i", async (chainId) => {
    const { asSchema } = await import("ai");
    const tools = buildTools({ adapters: [createRateAdapter()], ctx: { ...ctx, chainId } });
    expect(Object.keys(tools).length).toBeGreaterThan(0);
    for (const [name, t] of Object.entries(tools)) {
      const json = JSON.stringify(await asSchema((t as { inputSchema: Parameters<typeof asSchema>[0] }).inputSchema).jsonSchema);
      expect(json, name).not.toMatch(/\\\\p\{/);
    }
  });
});
