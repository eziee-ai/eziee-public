import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decidePrerun, readRequest, ROUTER_GATE, type Reading, type RouterFetch } from "./router";

const answer = (intent: string, intentConfidence: number, measure: string, measureConfidence: number) => ({
  model: "jev-1.13.0",
  answers: { intent: { type: "choice", choice: intent, probabilities: {}, confidence: intentConfidence }, measure: { type: "choice", choice: measure, probabilities: {}, confidence: measureConfidence } },
  usage: { input_tokens: 410, output_tokens: 60 },
});
const ok = (body: unknown): RouterFetch => vi.fn(async () => ({ ok: true, status: 200, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) }));
const reading = (over: Partial<Reading> = {}): Reading => ({ intent: "provide_liquidity", intentConfidence: 1, measure: "highest_yield", measureConfidence: 1, model: "jev", usage: { inputTokens: 1, outputTokens: 1 }, ms: 1, ...over });

describe("readRequest", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it("asks Jev two choice questions about the message and returns typed answers", async () => {
    const fetch = ok(answer("provide_liquidity", 0.99, "highest_yield", 0.97));
    const result = await readRequest({ message: "Where can I earn the highest APY?", apiKey: "k", fetch });
    expect(result).toMatchObject({ intent: "provide_liquidity", intentConfidence: 0.99, measure: "highest_yield", measureConfidence: 0.97, model: "jev-1.13.0", usage: { inputTokens: 410, outputTokens: 60 } });

    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init).toMatchObject({ method: "POST", redirect: "error", headers: { authorization: "Bearer k", "content-type": "application/json" } });
    const sent = JSON.parse(init.body) as { model: string; state: unknown; questions: Record<string, { type: string; criteria: Record<string, unknown> }> };
    expect(sent.model).toBe("jev-latest");
    // The message and NOTHING else: no address, no history, no market data.
    expect(sent.state).toEqual({ message: "Where can I earn the highest APY?" });
    expect(Object.keys(sent.questions).sort()).toEqual(["intent", "measure"]);
    expect(Object.keys(sent.questions.measure!.criteria)).toContain("unspecified");
    expect(init.body).not.toMatch(/0x[0-9a-fA-F]{40}/);
  });

  it("cuts a long message to 2,000 characters", async () => {
    const fetch = ok(answer("unclear", 0.5, "unspecified", 0.5));
    await readRequest({ message: "x".repeat(5_000), apiKey: "k", fetch });
    expect((JSON.parse(vi.mocked(fetch).mock.calls[0]![1].body) as { state: { message: string } }).state.message).toHaveLength(2_000);
  });

  it.each([
    ["a 401", async () => ({ ok: false, status: 401, text: async () => "{}" })],
    ["a 500", async () => ({ ok: false, status: 500, text: async () => "" })],
    ["a body that is not JSON", async () => ({ ok: true, status: 200, text: async () => "<html>" })],
    ["an answer that is not one of the options", async () => ({ ok: true, status: 200, text: async () => JSON.stringify(answer("rob_a_bank", 1, "highest_yield", 1)) })],
    ["a confidence outside 0..1", async () => ({ ok: true, status: 200, text: async () => JSON.stringify(answer("buy_asset", 7, "highest_yield", 1)) })],
    ["a body over 64 KB", async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ...answer("buy_asset", 1, "highest_yield", 1), pad: "p".repeat(70_000) }) })],
    ["a network failure", async () => { throw new Error("ECONNRESET secret-host.internal"); }],
  ] as const)("returns null on %s, and throws nothing", async (_name, impl) => {
    const canaryMessage = "canary-message-91c2 where is the best yield";
    const canaryApiKey = "sk-test-leak-canary-7f3a";
    expect(await readRequest({ message: canaryMessage, apiKey: canaryApiKey, fetch: vi.fn(impl) as unknown as RouterFetch })).toBeNull();
    const logged = warn.mock.calls.flat(2).join(" ");
    expect(logged).not.toContain("secret-host.internal");
    expect(logged).not.toContain(canaryMessage);
    expect(logged).not.toContain(canaryApiKey);
  });

  it("returns null and never throws when the caller's signal is not a real AbortSignal", async () => {
    const fetch = ok(answer("unclear", 1, "unspecified", 1));
    await expect(readRequest({ message: "hi", apiKey: "k", fetch, signal: {} as AbortSignal })).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("gives up after the timeout", async () => {
    const never: RouterFetch = (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    const started = Date.now();
    expect(await readRequest({ message: "hi", apiKey: "k", fetch: never, timeoutMs: 30 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("makes no call at all for an empty message", async () => {
    const fetch = ok(answer("unclear", 1, "unspecified", 1));
    expect(await readRequest({ message: "   ", apiKey: "k", fetch })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("decidePrerun", () => {
  it("pre-runs a confident buy or LP request that names a measure", () => {
    expect(decidePrerun(reading())).toEqual({ measure: "highest_yield" });
    expect(decidePrerun(reading({ intent: "buy_asset", measure: "weekly_momentum" }))).toEqual({ measure: "weekly_momentum" });
  });

  it.each([
    ["no reading", null],
    ["an intent under the gate", reading({ intentConfidence: ROUTER_GATE - 0.01 })],
    ["a measure under the gate", reading({ measureConfidence: ROUTER_GATE - 0.01 })],
    ["no measure stated: the desk does not advise", reading({ measure: "unspecified" })],
    ["an exact swap", reading({ intent: "swap_specific" })],
    ["an account question", reading({ intent: "account_info" })],
    ["a market question", reading({ intent: "market_info" })],
    ["an unclear message", reading({ intent: "unclear" })],
  ])("does not pre-run on %s", (_name, value) => expect(decidePrerun(value)).toBeNull());
});
