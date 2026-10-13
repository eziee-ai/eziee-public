import type { UIMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readRequest, type Reading } from "@repo/agent";
import type { AdapterContext, ProtocolAdapter } from "@repo/protocols/types";
import { readRequestFor, readerFromEnv, runPrerun } from "./prerun";

vi.mock("@repo/agent", async (importOriginal) => ({ ...(await importOriginal<typeof import("@repo/agent")>()), readRequest: vi.fn(async () => null) }));

const ctx = { chainId: 5042002, account: "0x0000000000000000000000000000000000001001", client: {} } as unknown as AdapterContext;
const user = (text: string): UIMessage => ({ id: "u1", role: "user", parts: [{ type: "text", text }] });
const confident: Reading = { intent: "provide_liquidity", intentConfidence: 0.99, measure: "highest_yield", measureConfidence: 0.97, model: "jev-1", usage: { inputTokens: 400, outputTokens: 60 }, ms: 321 };
const RANKED = { measure: "highest_yield", none: false, rows: [{ rank: 1, symbol: "DOUGH/USDC" }] };
const adapter = (id: string, run?: () => Promise<unknown>): ProtocolAdapter => ({ id, chains: [{ id: 5042002 }], reads: run ? { rank: { description: "", input: {} as never, run: vi.fn(run) } } : {}, actions: {} }) as unknown as ProtocolAdapter;

// A skipped pre-run says so on the server's log; the tests that provoke one do not print it.
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  vi.mocked(readRequest).mockClear();
});

describe("readRequestFor", () => {
  it("returns what Jev cost and the measure to rank by, and runs no read of its own", async () => {
    const rate = adapter("rate", async () => RANKED);
    const read = vi.fn(async () => confident);
    const reading = await readRequestFor({ messages: [user("highest APY pool?")], adapters: [adapter("other"), rate], read });
    expect(read).toHaveBeenCalledWith("highest APY pool?", undefined);
    expect(reading).toEqual({ usage: { model: "jev-1", inputTokens: 400, outputTokens: 60 }, router: { intent: "provide_liquidity", measure: "highest_yield", confidence: 0.97, ms: 321 }, measure: "highest_yield" });
    expect(rate.reads.rank!.run).not.toHaveBeenCalled(); // ranking is a separate step, taken only once the turn decides to
  });

  it("still reports what a dropped reading cost, with no measure to act on", async () => {
    const reading = await readRequestFor({ messages: [user("highest APY?")], adapters: [adapter("rate", async () => RANKED)], read: async () => ({ ...confident, intentConfidence: 0.5 }) });
    expect(reading).toMatchObject({ usage: { model: "jev-1", inputTokens: 400, outputTokens: 60 }, measure: null });
  });

  it("reads only the LAST user message's text", async () => {
    const read = vi.fn(async () => null);
    await readRequestFor({ messages: [user("first"), { id: "a", role: "assistant", parts: [{ type: "text", text: "ok" }] }, { id: "u2", role: "user", parts: [{ type: "text", text: "second" }, { type: "text", text: "part" }] }], adapters: [adapter("rate", async () => RANKED)], read });
    expect(read).toHaveBeenCalledWith("second part", undefined);
  });

  it("passes the turn's signal on, so a reading nobody is waiting for can be given up", async () => {
    const read = vi.fn(async () => null);
    const signal = AbortSignal.abort();
    await readRequestFor({ messages: [user("highest APY?")], adapters: [adapter("rate", async () => RANKED)], read, signal });
    expect(read).toHaveBeenCalledWith("highest APY?", signal);
  });

  it.each([
    ["there is no reader (no key)", { read: null }],
    ["the last message is not the person's (the browser is answering a tool call)", { messages: [user("x"), { id: "a", role: "assistant", parts: [] } as UIMessage] }],
    ["no adapter in scope can rank", { adapters: [adapter("other")] }],
  ])("makes no Jev call when %s", async (_name, over) => {
    const read = vi.fn(async () => confident);
    const input = { messages: [user("highest APY?")], adapters: [adapter("rate", async () => RANKED)], read, ...over } as Parameters<typeof readRequestFor>[0];
    expect(await readRequestFor(input)).toBeNull();
    if (input.read) expect(input.read).not.toHaveBeenCalled();
  });

  it.each([
    ["Jev gives no reading", async () => null],
    ["the reader throws", async () => { throw new Error("boom"); }],
    ["a message has no text at all", async () => confident],
  ])("is null, and throws nothing, when %s", async (name, read) => {
    const messages = name === "a message has no text at all" ? [{ id: "u1", role: "user", parts: [] } as UIMessage] : [user("highest APY?")];
    expect(await readRequestFor({ messages, adapters: [adapter("rate", async () => RANKED)], read: read as never })).toBeNull();
  });

  it("an adapter that explodes on inspection is a skip, not a failed turn", async () => {
    const hostile = { id: "bad", chains: [{ id: 5042002 }], actions: {}, get reads(): never { throw new Error("no"); } } as unknown as ProtocolAdapter;
    expect(await readRequestFor({ messages: [user("highest APY?")], adapters: [hostile], read: async () => confident })).toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});

describe("runPrerun", () => {
  it("runs the rank read once and hangs its finished part on the turn's own message id", async () => {
    const rate = adapter("rate", async () => RANKED);
    const plan = await runPrerun({ adapters: [adapter("other"), rate], ctx, measure: "highest_yield", messageId: "msg-1" });
    expect(rate.reads.rank!.run).toHaveBeenCalledTimes(1);
    expect(rate.reads.rank!.run).toHaveBeenCalledWith({ measure: "highest_yield", limit: 5 }, ctx);
    expect(plan).toMatchObject({ toolName: "rate_rank", input: { measure: "highest_yield", limit: 5 }, output: RANKED });
    expect(plan!.message).toMatchObject({ id: "msg-1", role: "assistant", parts: [{ type: "step-start" }, { type: "tool-rate_rank", toolCallId: plan!.toolCallId, state: "output-available", input: plan!.input, output: RANKED }] });
  });

  it("is null, and throws nothing, when the rank read fails", async () => {
    expect(await runPrerun({ adapters: [adapter("rate", async () => { throw new Error("gateway down"); })], ctx, measure: "highest_yield", messageId: "msg-1" })).toBeNull();
    expect(warn).toHaveBeenCalledWith("[prerun] skipped", expect.any(Error));
  });
});

describe("readerFromEnv", () => {
  it("is off without a key", () => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    expect(readerFromEnv()).toBeNull();
    vi.unstubAllEnvs();
  });

  it("with a key, hands it to the router and puts it in nothing it gives back", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "sk-secret-value");
    vi.mocked(readRequest).mockResolvedValueOnce(confident);
    const reader = readerFromEnv();
    expect(reader).not.toBeNull();
    const signal = new AbortController().signal;
    const reading = await reader!("highest APY?", signal);
    expect(readRequest).toHaveBeenCalledWith({ message: "highest APY?", apiKey: "sk-secret-value", signal });
    expect(reading).toEqual(confident);
    expect(JSON.stringify(reading)).not.toContain("sk-secret-value");
    vi.unstubAllEnvs();
  });
});
