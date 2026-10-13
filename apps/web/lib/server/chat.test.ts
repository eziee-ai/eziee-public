import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { parsePrice, readRequest, type AvailableModel, type Reading } from "@repo/agent";
import { applyCredit, ensureUser, getAccount, getChat, ledgerSum, listChats, placeHold } from "@repo/db";
import { creditLedger } from "@repo/db/schema";
import { createTestDb, type Db } from "@repo/db/testing";
import type { ProtocolAdapter } from "@repo/protocols/types";
import { handleChat } from "./chat";
import { readRequestFor } from "./prerun";

// The one call that would leave this machine. Everything else in the package is the real thing.
vi.mock("@repo/agent", async (importOriginal) => ({ ...(await importOriginal<typeof import("@repo/agent")>()), readRequest: vi.fn(async () => null) }));
// Watched, not replaced: every turn still runs the real reader, and a test can see what history it was given.
vi.mock("./prerun", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./prerun")>();
  return { ...actual, readRequestFor: vi.fn(actual.readRequestFor) };
});

const ALICE = "0x0000000000000000000000000000000000001001" as const;
const BOB = "0x0000000000000000000000000000000000001002" as const;
const info: AvailableModel = { id: "moonshotai/kimi-k3", label: "Kimi K3", isDefault: true, contextWindow: 256_000, price: parsePrice({ input: "0.000003", output: "0.000015" })! };

/** A model that says "Hello" and reports the given token usage. */
function model(usage = { input: 1000, output: 200 }) {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "Hello" },
          { type: "text-end", id: "t1" },
          { type: "finish", finishReason: { unified: "stop", raw: undefined }, logprobs: undefined, usage: { inputTokens: { total: usage.input, noCache: usage.input, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: usage.output, text: usage.output, reasoning: undefined } } },
        ],
      }),
    }),
  });
}

/** Every chunk the browser is given, parsed, in order. */
async function chunks(response: Response): Promise<Array<{ type?: string; messageMetadata?: Record<string, unknown> }>> {
  const text = await response.text();
  return text.split("\n").flatMap((line) => {
    if (!line.startsWith("data: ")) return [];
    const payload = line.slice("data: ".length).trim();
    return payload === "[DONE]" ? [] : [JSON.parse(payload) as { type?: string; messageMetadata?: Record<string, unknown> }];
  });
}

let nextId = 0;
const userMessage = (text: string) => ({ id: `u${++nextId}`, role: "user", parts: [{ type: "text", text }] });
/** `turns` exchanges of a long question and a short answer, then one more question: "turn {turns}". */
const longChat = (turns: number) => [
  ...Array.from({ length: turns }, (_, i) => [userMessage(`turn ${i}: ${"a long question ".repeat(40)}`), { id: `r${++nextId}`, role: "assistant", parts: [{ type: "text", text: "An answer." }] }]).flat(),
  userMessage(`turn ${turns}: the newest question`),
];
const body = (extra: Record<string, unknown> = {}) => ({ model: info.id, protocol: "auto", chainId: 5042002, messages: [userMessage("hi")], ...extra });

let db: Db;
// A skipped pre-run says so on the server's log; the tests that provoke one do not print it.
let warn: ReturnType<typeof vi.spyOn>;
// The turns that deliberately fail log for an operator too; the suite is not where those stacks belong.
let logged: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  // No test may reach TypeSafe. A turn given no `read` falls back to the environment's key, so there must not be one.
  vi.stubEnv("TYPESAFE_API_KEY", "");
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  logged = vi.spyOn(console, "error").mockImplementation(() => {});
  db = await createTestDb();
  await ensureUser(db, ALICE);
  await ensureUser(db, BOB);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  warn.mockRestore();
  logged.mockRestore();
});

describe("handleChat", () => {
  it("answers 402 with no credit, makes no model call, and charges nothing", async () => {
    let called = false;
    const language = new MockLanguageModelV4({ doStream: async () => { called = true; throw new Error("must not be called"); } });
    const response = await handleChat({ db, address: ALICE, body: body(), model: { language, info } });
    expect(response.status).toBe(402);
    const json = (await response.json()) as { error: { code: string }; spendableMicrousd: string; rails: string[] };
    expect(json.error.code).toBe("INSUFFICIENT_CREDIT");
    expect(json.spendableMicrousd).toBe("0");
    expect(called).toBe(false);
    expect(await listChats(db, ALICE)).toEqual([]);
  });

  it("streams a reply, charges the real cost plus margin, releases the hold, and saves the transcript", async () => {
    await applyCredit(db, { address: ALICE, amount: 5_000_000n, kind: "adjustment", ref: "seed" });
    const response = await handleChat({ db, address: ALICE, body: body(), model: { language: model(), info } });
    expect(response.status).toBe(200);
    const chatId = response.headers.get("x-chat-id")!;
    const text = await response.text(); // drain the stream so onEnd runs
    expect(text).toContain("Hello");

    // 1000 in × 3 + 200 out × 15 = 6000 micro-USD, +30% = 7800
    const account = await getAccount(db, ALICE);
    expect(account).toMatchObject({ balance: 5_000_000n - 7_800n, held: 0n });
    expect(await ledgerSum(db, ALICE)).toBe(account.balance);
    expect(text).toContain('"costMicrousd":"7800"');

    const saved = await getChat(db, { address: ALICE, chatId });
    expect(saved?.chat).toMatchObject({ title: "hi", model: info.id, protocol: "auto", chainId: 5042002 });
    expect(saved?.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("says on the finished reply what it used: its tokens, the prompt the model measured, the model's window, and what one send needs", async () => {
    // Asked first with no credit, the refusal says what one send needs. The finished reply must say the same.
    const refused = (await (await handleChat({ db, address: ALICE, body: body(), model: { language: model(), info } })).json()) as { neededMicrousd: string };
    await applyCredit(db, { address: ALICE, amount: 5_000_000n, kind: "adjustment", ref: "seed" });
    const response = await handleChat({ db, address: ALICE, body: body(), model: { language: model(), info } });
    const finish = (await chunks(response)).find((chunk) => chunk.type === "finish");
    // The context is the last call's own measured input, not the estimate: the model reported 1000.
    expect(finish?.messageMetadata).toEqual({ costMicrousd: "7800", usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0 }, contextTokens: 1000, contextWindow: 256_000, stoppedForBudget: false, sendFloorMicrousd: refused.neededMicrousd });
  });

  it("a continued reply says what ALL of its turns used, not only the last, and saves that", async () => {
    await applyCredit(db, { address: ALICE, amount: 5_000_000n, kind: "adjustment", ref: "seed" });
    // The browser answered one of the reply's tool calls and sent the reply back to be continued. Its metadata says
    // what the first turn cost. Values that are not whole numbers are not added in.
    const earlier = { id: "a-cont", role: "assistant", parts: [{ type: "text", text: "Working on it." }], metadata: { model: info.id, costMicrousd: "7800", usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 50 }, stoppedForBudget: true } };
    const response = await handleChat({ db, address: ALICE, body: body({ messages: [userMessage("go"), earlier] }), model: { language: model(), info } });
    const finish = (await chunks(response)).find((chunk) => chunk.type === "finish");
    expect(finish?.messageMetadata).toMatchObject({ costMicrousd: "15600", usage: { inputTokens: 2000, outputTokens: 400, cacheReadTokens: 50 }, stoppedForBudget: false });
    // Only this turn is charged: the first was settled when it ended.
    expect((await getAccount(db, ALICE)).balance).toBe(5_000_000n - 7_800n);
    const saved = (await getChat(db, { address: ALICE, chatId: response.headers.get("x-chat-id")! }))!.messages;
    expect(saved.map((m) => m.id)).toEqual([expect.any(String), "a-cont"]);
    expect(saved[1]!.metadata).toMatchObject({ costMicrousd: "15600", usage: { inputTokens: 2000, outputTokens: 400, cacheReadTokens: 50 }, stoppedForBudget: false });
  });

  it("does not add in what a continued reply claims when it is not a whole number", async () => {
    await applyCredit(db, { address: ALICE, amount: 5_000_000n, kind: "adjustment", ref: "seed" });
    const earlier = { id: "a-bad", role: "assistant", parts: [{ type: "text", text: "Working on it." }], metadata: { costMicrousd: "1e9", usage: { inputTokens: 1.5, outputTokens: -3, cacheReadTokens: "x" } } };
    const response = await handleChat({ db, address: ALICE, body: body({ messages: [userMessage("go"), earlier] }), model: { language: model(), info } });
    const finish = (await chunks(response)).find((chunk) => chunk.type === "finish");
    expect(finish?.messageMetadata).toMatchObject({ costMicrousd: "7800", usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0 } });
  });

  it("sends the model only the newest turns that fit its window, says how many it left out, and still saves them all", async () => {
    await applyCredit(db, { address: ALICE, amount: 5_000_000n, kind: "adjustment", ref: "seed" });
    const { language, prompts } = recorder();
    const history = longChat(60);
    const response = await handleChat({ db, address: ALICE, body: body({ messages: history }), model: { language, info: { ...info, contextWindow: 24_000 } } });
    const all = await chunks(response);

    const sent = prompts[0]!;
    const sentUsers = sent.filter((m) => m.role === "user");
    expect(sentUsers.length).toBeGreaterThan(1);
    expect(sentUsers.length).toBeLessThan(61);
    expect(sent.find((m) => m.role !== "system")?.role).toBe("user");
    expect(JSON.stringify(sent.at(-1))).toContain("turn 60");
    const start = all.find((chunk) => chunk.type === "start");
    expect(start?.messageMetadata?.trimmed).toBe(history.length - (sent.length - 1));
    expect(start?.messageMetadata?.trimmed).toBeGreaterThan(0);
    // The context the reply reports is what was sent, far below what the whole chat would have been.
    const contextTokens = all.find((chunk) => chunk.type === "finish")?.messageMetadata?.contextTokens as number;
    expect(contextTokens).toBeGreaterThan(0);
    expect(contextTokens).toBeLessThan(JSON.stringify(history).length / 3);

    const saved = (await getChat(db, { address: ALICE, chatId: response.headers.get("x-chat-id")! }))!.messages;
    expect(saved).toHaveLength(history.length + 1);
    expect(saved[0]!.id).toBe(history[0]!.id);
  });

  it("says nothing was left out when the whole chat was sent", async () => {
    await applyCredit(db, { address: ALICE, amount: 5_000_000n, kind: "adjustment", ref: "seed" });
    const response = await handleChat({ db, address: ALICE, body: body(), model: { language: model(), info } });
    expect((await chunks(response)).find((chunk) => chunk.type === "start")?.messageMetadata).toMatchObject({ trimmed: 0 });
  });

  it("never charges more than was held, however much the model reports", async () => {
    await applyCredit(db, { address: ALICE, amount: 5_000_000n, kind: "adjustment", ref: "seed" });
    const response = await handleChat({ db, address: ALICE, body: body(), model: { language: model({ input: 50_000_000, output: 1_000_000 }), info } });
    await response.text();
    const account = await getAccount(db, ALICE);
    expect(account.held).toBe(0n);
    // The model claimed about $165 of usage. What is charged is the hold: two worst-case calls for a short message, about $0.22.
    expect(5_000_000n - account.balance).toBeLessThan(300_000n);
    expect(account.balance).toBeGreaterThan(0n);
  });

  it("charges exactly what a tool loop really cost, and stops the loop before a step that could pass the hold", async () => {
    await applyCredit(db, { address: ALICE, amount: 5_000_000n, kind: "adjustment", ref: "seed" });
    let calls = 0;
    // Every call asks for the token list again and reports a large, growing prompt: a loop that would run to the step limit.
    const language = new MockLanguageModelV4({
      doStream: async () => {
        calls += 1;
        const input = 20_000 * calls;
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "tool-call", toolCallId: `c${calls}`, toolName: "rate_tokens", input: "{}" },
              { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, logprobs: undefined, usage: { inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 3_000, text: 3_000, reasoning: undefined } } },
            ],
          }),
        };
      },
    });
    const response = await handleChat({ db, address: ALICE, body: body(), model: { language, info } });
    const text = await response.text();

    // Step 1 really cost (20,000 × 3 + 3,000 × 15) × 1.3 = 136,500. A second step could not fit in the hold, so it never ran.
    expect(calls).toBe(1);
    const account = await getAccount(db, ALICE);
    expect(5_000_000n - account.balance).toBe(136_500n);
    expect(account.held).toBe(0n);
    expect(text).toContain('"costMicrousd":"136500"');
    expect(text).toContain('"stoppedForBudget":true');
  });

  it("with less than the usual hold but enough for one worst-case call, holds all of it and answers", async () => {
    await applyCredit(db, { address: ALICE, amount: 150_000n, kind: "adjustment", ref: "seed" });
    const response = await handleChat({ db, address: ALICE, body: body(), model: { language: model(), info } });
    expect(response.status).toBe(200);
    await response.text();
    expect(await getAccount(db, ALICE)).toMatchObject({ balance: 150_000n - 7_800n, held: 0n });
  });

  it("with less than one worst-case call, answers 402 and says how much one call needs", async () => {
    await applyCredit(db, { address: ALICE, amount: 50_000n, kind: "adjustment", ref: "seed" });
    const response = await handleChat({ db, address: ALICE, body: body(), model: { language: model(), info } });
    expect(response.status).toBe(402);
    const json = (await response.json()) as { spendableMicrousd: string; neededMicrousd: string };
    expect(json.spendableMicrousd).toBe("50000");
    expect(BigInt(json.neededMicrousd)).toBeGreaterThan(50_000n);
    expect((await getAccount(db, ALICE)).held).toBe(0n);
  });

  it("gives back credit locked by a request that never finished, the next time the account chats, but not while it could still be running", async () => {
    await applyCredit(db, { address: ALICE, amount: 5_000_000n, kind: "adjustment", ref: "seed" });
    expect((await placeHold(db, ALICE, 4_950_000n)).ok).toBe(true); // a request the platform killed mid-stream
    expect((await handleChat({ db, address: ALICE, body: body(), model: { language: model(), info } })).status).toBe(402);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 16 * 60_000);
    const response = await handleChat({ db, address: ALICE, body: body(), model: { language: model(), info } });
    expect(response.status).toBe(200);
    await response.text();
    expect(await getAccount(db, ALICE)).toMatchObject({ balance: 5_000_000n - 7_800n, held: 0n });
  });

  it("a tool call the browser never answered does not poison the chat: it reaches the model as an action whose outcome is unknown", async () => {
    await applyCredit(db, { address: ALICE, amount: 5_000_000n, kind: "adjustment", ref: "seed" });
    let prompt = "";
    const language = new MockLanguageModelV4({
      doStream: async (options) => {
        prompt = JSON.stringify(options.prompt);
        return model().doStream(options);
      },
    });
    const abandoned = { id: "a1", role: "assistant", parts: [{ type: "step-start" }, { type: "tool-rate_placeOrder", toolCallId: "c1", state: "input-available", input: { side: "buy", base: BOB, quote: ALICE, price: "1", amount: "2" } }] };
    // A tool this network does not have at all: the person switched networks after abandoning the action.
    const foreign = { id: "a2", role: "assistant", parts: [{ type: "step-start" }, { type: "tool-ghost_action", toolCallId: "c2", state: "input-available", input: {} }] };
    const response = await handleChat({ db, address: ALICE, body: body({ messages: [userMessage("buy"), abandoned, userMessage("and?"), foreign, userMessage("hello again")] }), model: { language, info } });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Hello");
    expect(prompt).toContain("outcome is unknown");
    expect((await getAccount(db, ALICE)).held).toBe(0n);
  });

  it("an unexpected failure is an answer with a code, never a bare 500, and leaves no credit held", async () => {
    await applyCredit(db, { address: ALICE, amount: 5_000_000n, kind: "adjustment", ref: "seed" });
    const broken = new Proxy(db, { get: (target, key, receiver) => (key === "insert" ? () => { throw new Error("database went away: postgres://user:secret@host"); } : Reflect.get(target, key, receiver)) });
    const response = await handleChat({ db: broken, address: ALICE, body: body(), model: { language: model(), info } });
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ error: { code: "CHAT_FAILED" } });
    expect(text).not.toContain("secret");
  });

  it("says a conversation is too long in words the person can act on", async () => {
    await applyCredit(db, { address: ALICE, amount: 5_000_000n, kind: "adjustment", ref: "seed" });
    const response = await handleChat({ db, address: ALICE, body: body({ messages: Array.from({ length: 1_001 }, () => userMessage("hi")) }), model: { language: model(), info } });
    expect(response.status).toBe(400);
    expect((await response.json()) as unknown).toMatchObject({ error: { code: "CHAT_TOO_LONG", message: expect.stringContaining("new chat") } });
  });

  it("a reply the person stopped is still charged for what ran, and says what it cost", async () => {
    await applyCredit(db, { address: ALICE, amount: 5_000_000n, kind: "adjustment", ref: "seed" });
    const stop = new AbortController();
    let calls = 0;
    const language = new MockLanguageModelV4({
      doStream: async (options) => {
        calls += 1;
        if (calls === 2) stop.abort();
        return calls === 1
          ? { stream: simulateReadableStream({ chunks: [{ type: "tool-call", toolCallId: "c1", toolName: "rate_tokens", input: "{}" }, { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, logprobs: undefined, usage: { inputTokens: { total: 1000, noCache: 1000, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 200, text: 200, reasoning: undefined } } }] }) }
          : model().doStream(options);
      },
    });
    const response = await handleChat({ db, address: ALICE, body: body(), signal: stop.signal, model: { language, info } });
    const text = await response.text();
    const account = await getAccount(db, ALICE);
    expect(account.held).toBe(0n);
    expect(5_000_000n - account.balance).toBeGreaterThanOrEqual(7_800n);
    expect(text).toMatch(/"costMicrousd":"\d+"/);
  });

  it("a second turn in the same chat is saved too: every reply has its own id, in order", async () => {
    await applyCredit(db, { address: ALICE, amount: 5_000_000n, kind: "adjustment", ref: "seed" });
    const first = await handleChat({ db, address: ALICE, body: body(), model: { language: model(), info } });
    await first.text();
    const chatId = first.headers.get("x-chat-id")!;
    const history = (await getChat(db, { address: ALICE, chatId }))!.messages.map((m) => ({ id: m.id, role: m.role, parts: m.parts }));

    const second = await handleChat({ db, address: ALICE, body: body({ chatId, messages: [...history, userMessage("and again")] }), model: { language: model(), info } });
    await second.text();
    const saved = (await getChat(db, { address: ALICE, chatId }))!.messages;
    expect(saved.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(saved.every((m) => m.id.length > 0)).toBe(true);
    expect(new Set(saved.map((m) => m.id)).size).toBe(4);
  });

  it("remembers, per chat, what the last message was sent with", async () => {
    await applyCredit(db, { address: ALICE, amount: 5_000_000n, kind: "adjustment", ref: "seed" });
    const first = await handleChat({ db, address: ALICE, body: body(), model: { language: model(), info } });
    await first.text();
    const chatId = first.headers.get("x-chat-id")!;
    const second = await handleChat({ db, address: ALICE, body: body({ chatId, protocol: "rate", chainId: 11155931 }), model: { language: model(), info } });
    await second.text();
    expect((await getChat(db, { address: ALICE, chatId }))?.chat).toMatchObject({ protocol: "rate", chainId: 11155931 });
  });

  it("a tab opened before Iter became Rate can carry on: its old protocol id and tool parts are read as Rate's", async () => {
    await applyCredit(db, { address: ALICE, amount: 5_000_000n, kind: "adjustment", ref: "seed" });
    const old = { id: "a1", role: "assistant", parts: [{ type: "step-start" }, { type: "tool-iter_balances", toolCallId: "c1", state: "output-available", input: {}, output: { balances: [] } }, { type: "text", text: "You hold nothing yet." }] };
    const response = await handleChat({ db, address: ALICE, body: body({ protocol: "iter", messages: [userMessage("balances?"), old, userMessage("hello again")] }), model: { language: model(), info } });
    expect(response.status).toBe(200);
    await response.text();
    const saved = await getChat(db, { address: ALICE, chatId: response.headers.get("x-chat-id")! });
    expect(saved?.chat.protocol).toBe("rate");
    expect(JSON.stringify(saved?.messages)).toContain("tool-rate_balances");
    expect(JSON.stringify(saved?.messages)).not.toContain("tool-iter_");
  });

  it("refuses another person's chat id", async () => {
    await applyCredit(db, { address: ALICE, amount: 5_000_000n, kind: "adjustment", ref: "a" });
    await applyCredit(db, { address: BOB, amount: 5_000_000n, kind: "adjustment", ref: "b" });
    const first = await handleChat({ db, address: ALICE, body: body(), model: { language: model(), info } });
    await first.text();
    const response = await handleChat({ db, address: BOB, body: body({ chatId: first.headers.get("x-chat-id") }), model: { language: model(), info } });
    expect(response.status).toBe(404);
    expect((await getAccount(db, BOB)).held).toBe(0n);
  });

  it.each([
    ["a network this app does not serve", { chainId: 1 }, "UNSUPPORTED_CHAIN"],
    ["a protocol that is not on this network", { protocol: "uniswap" }, "UNKNOWN_PROTOCOL"],
    ["no messages", { messages: [] }, "INVALID_REQUEST"],
    ["a malformed message", { messages: [{ role: "user" }] }, "INVALID_MESSAGES"],
  ])("refuses %s before holding any credit", async (_name, patch, code) => {
    await applyCredit(db, { address: ALICE, amount: 5_000_000n, kind: "adjustment", ref: "seed" });
    const response = await handleChat({ db, address: ALICE, body: body(patch), model: { language: model(), info } });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(code);
    expect((await getAccount(db, ALICE)).held).toBe(0n);
  });
});


function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const RANKED = { measure: "highest_yield", basis: "b", minTvlUSD: 10_000, considered: 2, eligible: 1, none: false, rows: [{ rank: 1, id: "0x01", symbol: "DOUGH/USDC", base: { address: "0x02", symbol: "DOUGH" }, quote: { address: "0x03", symbol: "USDC" }, tvlUSD: 120_000, volume24hUSD: 310_000, feeBps: 30, estLpFeeAprPct: 282.9, change7dPct: -6, change30dPct: -38 }] };
const confident: Reading = { intent: "provide_liquidity", intentConfidence: 0.99, measure: "highest_yield", measureConfidence: 0.98, model: "jev-1", usage: { inputTokens: 400, outputTokens: 60 }, ms: 300 };
const rankRun = vi.fn(async () => RANKED);
const ranker = (): ProtocolAdapter => ({ id: "rate", chains: [{ id: 5042002 }], contracts: () => ({}), tokens: () => [], actions: {}, reads: { rank: { description: "rank", input: z.object({ measure: z.string(), limit: z.number().optional() }), run: rankRun } }, decode: () => null }) as unknown as ProtocolAdapter;

/**
 * Records every prompt it is given, then says "DOUGH leads.".
 *
 * `holdFirstCall` keeps the FIRST call silent until it is aborted, which is how a test says "the reader got
 * there first". Without it the first call answers at once, which is how a test says "the model got there first".
 * `delayMs` sits between the two: the model does answer, but not before a reader that answers in a microtask.
 */
function recorder(options: { holdFirstCall?: boolean; delayMs?: number } = {}) {
  const prompts: Array<Array<{ role: string }>> = [];
  const signals: AbortSignal[] = [];
  const speaking = deferred();
  let calls = 0;
  const language = new MockLanguageModelV4({
    doStream: async ({ prompt, abortSignal }) => {
      calls += 1;
      prompts.push(prompt as never);
      if (abortSignal) signals.push(abortSignal);
      if (options.holdFirstCall && calls === 1) {
        // Silent until the server gives up on it, exactly like a call that is aborted before its first token.
        return { stream: new ReadableStream({ start: (controller) => { abortSignal?.addEventListener("abort", () => controller.close()); } }) };
      }
      speaking.resolve();
      return { stream: simulateReadableStream({ initialDelayInMs: options.delayMs ?? 0, chunks: [{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "DOUGH leads." }, { type: "text-end", id: "t" }, { type: "finish", finishReason: { unified: "stop", raw: undefined }, logprobs: undefined, usage: { inputTokens: { total: 1000, noCache: 1000, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 200, text: 200, reasoning: undefined } } }] }) };
    },
  });
  return { language, prompts, signals, speaking: speaking.promise, get calls() { return calls; } };
}

/** The type of every chunk the browser is given, in order. Ids and metadata values differ per turn; the shape must not. */
async function chunkTypes(response: Response): Promise<string[]> {
  return (await chunks(response)).flatMap(({ type }) => (typeof type === "string" ? [type] : []));
}

/** The `usage` row this turn settled with, which is where the reader's own cost is recorded (spec R6, R9). */
async function settledMeta(): Promise<Record<string, unknown> | null> {
  const rows = await db.select().from(creditLedger);
  return (rows.find((row) => row.kind === "usage")?.meta as Record<string, unknown> | undefined) ?? null;
}

describe("a pre-run turn", () => {
  beforeEach(() => rankRun.mockClear());

  it("streams the rank part before the text, calls the model again with the result already in hand, settles, and saves one assistant message", async () => {
    await applyCredit(db, { address: ALICE, amount: 5_000_000n, kind: "adjustment", ref: "seed" });
    const { language, prompts, signals } = recorder({ holdFirstCall: true });
    const read = vi.fn(async () => confident);
    const response = await handleChat({ db, address: ALICE, body: body({ messages: [userMessage("Where can I earn the highest APY providing liquidity?")] }), model: { language, info }, read, adapters: [ranker()] });
    expect(response.status).toBe(200);
    const text = await response.text();

    expect(read).toHaveBeenCalledTimes(1);
    expect(rankRun).toHaveBeenCalledTimes(1); // by the server, and NOT again by the agent
    expect(signals[0]!.aborted).toBe(true); // the speculative call was given up on
    expect(prompts).toHaveLength(2); // the aborted one, then the real one
    expect(prompts[0]!.map((m) => m.role)).toEqual(["system", "user"]);
    expect(prompts[1]!.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);

    expect(text.match(/"type":"start"/g)).toHaveLength(1); // ONE assistant message, not one per call
    expect(text.indexOf("tool-output-available")).toBeGreaterThan(-1);
    expect(text.indexOf("tool-output-available")).toBeLessThan(text.indexOf("DOUGH leads."));
    expect(text).toContain('"router":{"intent":"provide_liquidity","measure":"highest_yield"');
    expect(text).toContain('"contextWindow":256000'); // the pre-run turn ends with the same metadata as the ordinary one

    const saved = await getChat(db, { address: ALICE, chatId: response.headers.get("x-chat-id")! });
    expect(saved?.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    const parts = (saved!.messages[1]!.parts as Array<{ type: string }>).map((p) => p.type);
    expect(parts.filter((t) => t === "tool-rate_rank")).toHaveLength(1);
    expect(parts.at(-1)).toBe("text");
    // One id from the first `start` the browser saw, through the pre-run message, to the row in the database.
    expect(text).toContain(`"messageId":"${saved!.messages[1]!.id}"`);
    expect((await getAccount(db, ALICE)).held).toBe(0n);
  });

  it("the saved pre-run turn is valid history: the next message in the same chat is accepted, and both turns are saved", async () => {
    await applyCredit(db, { address: ALICE, amount: 5_000_000n, kind: "adjustment", ref: "seed" });
    const first = await handleChat({ db, address: ALICE, body: body({ messages: [userMessage("highest APY to LP?")] }), model: { language: recorder({ holdFirstCall: true }).language, info }, read: async () => confident, adapters: [ranker()] });
    await first.text();
    const chatId = first.headers.get("x-chat-id")!;
    const history = (await getChat(db, { address: ALICE, chatId }))!.messages.map((m) => ({ id: m.id, role: m.role, parts: m.parts }));
    const second = await handleChat({ db, address: ALICE, body: body({ chatId, messages: [...history, userMessage("and the deepest?")] }), model: { language: recorder({ holdFirstCall: true }).language, info }, read: async () => confident, adapters: [ranker()] });
    expect(second.status).toBe(200);
    await second.text();

    // Two server-made assistant ids in one chat must not collide.
    const saved = (await getChat(db, { address: ALICE, chatId }))!.messages;
    expect(saved.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(new Set(saved.map((m) => m.id)).size).toBe(4);
  });

  it("reads, and restarts the model with, only the history that fits the window", async () => {
    await applyCredit(db, { address: ALICE, amount: 5_000_000n, kind: "adjustment", ref: "seed" });
    const { language, prompts } = recorder({ holdFirstCall: true });
    const history = [...longChat(60).slice(0, -1), userMessage("Where can I earn the highest APY providing liquidity?")];
    const response = await handleChat({ db, address: ALICE, body: body({ messages: history }), model: { language, info: { ...info, contextWindow: 24_000 } }, read: async () => confident, adapters: [ranker()] });
    const all = await chunks(response);
    expect(prompts).toHaveLength(2);
    // The one start the browser is given, written by the restart, says how much was left out.
    const starts = all.filter((chunk) => chunk.type === "start");
    expect(starts).toHaveLength(1);
    expect(starts[0]!.messageMetadata?.trimmed).toBeGreaterThan(0);
    for (const prompt of prompts) {
      expect(prompt.filter((m) => m.role === "user").length).toBeGreaterThan(1);
      expect(prompt.filter((m) => m.role === "user").length).toBeLessThan(61);
      expect(prompt.find((m) => m.role !== "system")?.role).toBe("user");
    }
    expect(prompts[1]!.slice(-2).map((m) => m.role)).toEqual(["assistant", "tool"]);
    expect((await getChat(db, { address: ALICE, chatId: response.headers.get("x-chat-id")! }))!.messages).toHaveLength(history.length + 1);
  });

  it("gives the reader the trimmed history, not the whole chat", async () => {
    await applyCredit(db, { address: ALICE, amount: 5_000_000n, kind: "adjustment", ref: "seed" });
    vi.mocked(readRequestFor).mockClear();
    const history = [...longChat(60).slice(0, -1), userMessage("Where can I earn the highest APY providing liquidity?")];
    const response = await handleChat({ db, address: ALICE, body: body({ messages: history }), model: { language: recorder({ holdFirstCall: true }).language, info: { ...info, contextWindow: 24_000 } }, read: async () => confident, adapters: [ranker()] });
    const trimmed = (await chunks(response)).find((chunk) => chunk.type === "start")?.messageMetadata?.trimmed as number;
    expect(trimmed).toBeGreaterThan(0);

    expect(readRequestFor).toHaveBeenCalledTimes(1);
    const { messages } = vi.mocked(readRequestFor).mock.calls[0]![0];
    expect(messages).toHaveLength(history.length - trimmed);
    expect(messages.length).toBeLessThan(history.length);
    expect(messages[0]!.role).toBe("user");
    expect(messages.at(-1)!.id).toBe(history.at(-1)!.id);
  });

  it("with no reading, the turn is exactly the ordinary one", async () => {
    await applyCredit(db, { address: ALICE, amount: 5_000_000n, kind: "adjustment", ref: "seed" });
    const { language, prompts } = recorder();
    const response = await handleChat({ db, address: ALICE, body: body(), model: { language, info }, read: async () => null, adapters: [ranker()] });
    const text = await response.text();
    expect(rankRun).not.toHaveBeenCalled();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.map((m) => m.role)).toEqual(["system", "user"]);
    expect(text).not.toContain('"router"');
    expect(await getAccount(db, ALICE)).toMatchObject({ balance: 5_000_000n - 7_800n, held: 0n });
  });

  it("with no credit, Jev is never called", async () => {
    const read = vi.fn(async () => confident);
    const response = await handleChat({ db, address: ALICE, body: body(), model: { language: recorder().language, info }, read, adapters: [ranker()] });
    expect(response.status).toBe(402);
    expect(read).not.toHaveBeenCalled();
  });

  it("a pre-run turn whose model fails still settles, and says nothing of what went wrong", async () => {
    await applyCredit(db, { address: ALICE, amount: 5_000_000n, kind: "adjustment", ref: "seed" });
    // Every call fails, so this holds whichever call the turn ends on.
    const broken = new MockLanguageModelV4({ doStream: async () => { throw new Error("gateway down: https://gateway.example/key-abc"); } });
    const response = await handleChat({ db, address: ALICE, body: body({ messages: [userMessage("highest APY to LP?")] }), model: { language: broken, info }, read: async () => confident, adapters: [ranker()] });
    expect(response.status).toBe(200); // whatever was already sent stands; the failure is a part of the stream, not a status
    const text = await response.text();
    expect(text).toContain("could not answer just now");
    expect(text).not.toContain("key-abc");
    expect(await getAccount(db, ALICE)).toMatchObject({ held: 0n });
  });

  it("a pre-run turn the person stops after the switch is still settled: no credit stays held", async () => {
    await applyCredit(db, { address: ALICE, amount: 5_000_000n, kind: "adjustment", ref: "seed" });
    // The reader answers at once and the model never does, so the turn has certainly switched before it is stopped.
    const stalling = new MockLanguageModelV4({ doStream: async () => ({ stream: simulateReadableStream({ initialDelayInMs: 5_000, chunkDelayInMs: 5_000, chunks: [{ type: "text-start", id: "t" }, { type: "text-end", id: "t" }, { type: "finish", finishReason: { unified: "stop", raw: undefined }, logprobs: undefined, usage: { inputTokens: { total: 1000, noCache: 1000, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 200, text: 200, reasoning: undefined } } }] }) }) });
    const controller = new AbortController();
    const response = await handleChat({ db, address: ALICE, body: body({ messages: [userMessage("highest APY to LP?")] }), model: { language: stalling, info }, read: async () => confident, adapters: [ranker()], signal: controller.signal });
    const reader = response.body!.getReader();
    await reader.read();
    await vi.waitFor(() => expect(rankRun).toHaveBeenCalledTimes(1)); // the switch has happened
    expect((await getAccount(db, ALICE)).held).toBeGreaterThan(0n);

    controller.abort();
    await reader.cancel().catch(() => {});
    await vi.waitFor(async () => expect((await getAccount(db, ALICE)).held).toBe(0n), { timeout: 5_000 });
    // The restarted call never finished a step, so there is no measured input to charge the abandoned one by,
    // and nothing is charged for it (spec R9): this turn costs nothing at all, so it writes no ledger row.
    expect((await getAccount(db, ALICE)).balance).toBe(5_000_000n);
    expect(await settledMeta()).toBeNull();
  }, 20_000);
});

describe("the reader beside the model", () => {
  beforeEach(() => rankRun.mockClear());

  it("an ordinary message waits for nothing: the reply streams while the reader is still pending", async () => {
    await applyCredit(db, { address: ALICE, amount: 5_000_000n, kind: "adjustment", ref: "seed" });
    const { language, prompts } = recorder();
    const pending = deferred<null>(); // never resolved by this test
    const response = await handleChat({ db, address: ALICE, body: body(), model: { language, info }, read: () => pending.promise, adapters: [ranker()] });
    const text = await response.text();
    expect(text).toContain("DOUGH leads.");
    expect(prompts).toHaveLength(1);
    expect(rankRun).not.toHaveBeenCalled();
    expect(await getAccount(db, ALICE)).toMatchObject({ balance: 5_000_000n - 7_800n, held: 0n });
    expect((await getChat(db, { address: ALICE, chatId: response.headers.get("x-chat-id")! }))?.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("the reader and the model are started together: the model is called before the reader answers", async () => {
    await applyCredit(db, { address: ALICE, amount: 5_000_000n, kind: "adjustment", ref: "seed" });
    const { language, prompts } = recorder({ holdFirstCall: true });
    const gate = deferred<Reading>();
    const response = await handleChat({ db, address: ALICE, body: body({ messages: [userMessage("highest APY to LP?")] }), model: { language, info }, read: () => gate.promise, adapters: [ranker()] });
    await vi.waitFor(() => expect(prompts).toHaveLength(1)); // the model is running while the reader still has not answered
    gate.resolve(confident);
    const text = await response.text();
    expect(text).toContain("DOUGH leads.");
  }, 20_000);

  it("a reading that arrives AFTER the model has said something is ignored", async () => {
    await applyCredit(db, { address: ALICE, amount: 5_000_000n, kind: "adjustment", ref: "seed" });
    const { language, prompts } = recorder();
    const gate = deferred<Reading>();
    const response = await handleChat({ db, address: ALICE, body: body({ messages: [userMessage("highest APY to LP?")] }), model: { language, info }, read: () => gate.promise, adapters: [ranker()] });
    const reader = response.body!.getReader();
    // Read until the model's own words are on the wire: the turn has committed to the ordinary path.
    let seen = "";
    while (!seen.includes("DOUGH leads.")) seen += new TextDecoder().decode((await reader.read()).value);
    gate.resolve(confident);
    while (!(await reader.read()).done) { /* drain */ }

    expect(rankRun).not.toHaveBeenCalled();
    expect(prompts).toHaveLength(1);
    expect(seen).not.toContain('"router"');
    await vi.waitFor(async () => expect((await getAccount(db, ALICE)).held).toBe(0n));
    expect(await getAccount(db, ALICE)).toMatchObject({ balance: 5_000_000n - 7_800n });
  }, 20_000);

  it.each([
    ["is under the gate", async () => ({ ...confident, intentConfidence: 0.5 })],
    ["is not a buy or an LP question", async () => ({ ...confident, intent: "market_info" as const })],
    ["is null", async () => null],
    ["throws", async () => { throw new Error("boom"); }],
  ])("leaves the speculative call alone when the reading %s", async (_name, read) => {
    await applyCredit(db, { address: ALICE, amount: 5_000_000n, kind: "adjustment", ref: "seed" });
    const { language, prompts, signals } = recorder();
    const response = await handleChat({ db, address: ALICE, body: body({ messages: [userMessage("highest APY to LP?")] }), model: { language, info }, read: read as never, adapters: [ranker()] });
    const text = await response.text();
    expect(rankRun).not.toHaveBeenCalled();
    expect(prompts).toHaveLength(1);
    expect(signals[0]?.aborted ?? false).toBe(false);
    expect(text).not.toContain('"router"');
    expect(await getAccount(db, ALICE)).toMatchObject({ balance: 5_000_000n - 7_800n, held: 0n });
  });

  it("records what the reader cost even when its reading is dropped, and shows the person nothing (spec R6)", async () => {
    await applyCredit(db, { address: ALICE, amount: 5_000_000n, kind: "adjustment", ref: "seed" });
    const response = await handleChat({ db, address: ALICE, body: body(), model: { language: recorder().language, info }, read: async () => ({ ...confident, intentConfidence: 0.5 }), adapters: [ranker()] });
    const text = await response.text();
    expect(text).not.toContain('"router"'); // nothing on the reply: no pre-run happened
    await vi.waitFor(async () => expect((await getAccount(db, ALICE)).held).toBe(0n));
    expect(await settledMeta()).toMatchObject({ router: { model: "jev-1", inputTokens: 400, outputTokens: 60 } });
    expect(await getAccount(db, ALICE)).toMatchObject({ balance: 5_000_000n - 7_800n }); // and it is not charged for
  });

  it("charges for the call it gave up on at the restarted call's own measured input (spec R9)", async () => {
    await applyCredit(db, { address: ALICE, amount: 5_000_000n, kind: "adjustment", ref: "seed" });
    const response = await handleChat({ db, address: ALICE, body: body({ messages: [userMessage("highest APY to LP?")] }), model: { language: recorder({ holdFirstCall: true }).language, info }, read: async () => confident, adapters: [ranker()] });
    const text = await response.text();

    // The call that was given up on carried the same prompt, so the restarted call's own input count is what it
    // cost, measured by the provider's tokenizer rather than guessed: (1000×3 + 200×15 + 1000×3) × 1.3 = 11,700.
    const account = await getAccount(db, ALICE);
    expect(5_000_000n - account.balance).toBe(11_700n);
    // The reply says the same number the ledger took. Had the total passed the hold, the reply would have
    // reported the hold while the ledger took the hold too, so a charge that ran past it cannot hide here.
    expect(text).toContain('"costMicrousd":"11700"');
    expect(account.held).toBe(0n);
    // What Jev itself cost is on the settlement of a turn that pre-ran, as it is on one whose reading was dropped.
    expect(await settledMeta()).toMatchObject({ router: { model: "jev-1", inputTokens: 400, outputTokens: 60, speculative: { inputTokens: 1000, estimated: false } } });
  });

  it("with a reader that reads nothing, the browser is given the same sequence of chunks as with no reader at all", async () => {
    await applyCredit(db, { address: ALICE, amount: 5_000_000n, kind: "adjustment", ref: "seed" });
    // The same scripted model, answered twice: once down the path that has no reader, once down the path that
    // has one which finds nothing. What the browser is handed must be the same shape, chunk for chunk.
    const withoutReader = await handleChat({ db, address: ALICE, body: body(), model: { language: model(), info }, read: null, adapters: [ranker()] });
    const withReader = await handleChat({ db, address: ALICE, body: body(), model: { language: model(), info }, read: async () => null, adapters: [ranker()] });
    const shape = await chunkTypes(withReader);
    expect(shape).toEqual(await chunkTypes(withoutReader));
    expect(shape).toEqual(expect.arrayContaining(["start", "text-delta", "finish"])); // and not two empty sequences
    expect(rankRun).not.toHaveBeenCalled();
  });

  it("a rank read that fails after a confident reading gives nothing up: the ordinary turn carries on", async () => {
    await applyCredit(db, { address: ALICE, amount: 5_000_000n, kind: "adjustment", ref: "seed" });
    rankRun.mockRejectedValueOnce(new Error("gateway down"));
    // The reader answers in a microtask and the model waits, so the rank read is certainly reached.
    const { language, prompts, signals } = recorder({ delayMs: 30 });
    const SECRET = "my wallet is 0xFEEDFACE and I want the highest APY";
    const response = await handleChat({ db, address: ALICE, body: body({ messages: [userMessage(SECRET)] }), model: { language, info }, read: async () => confident, adapters: [ranker()] });
    const text = await response.text();

    // The skip is logged for an operator, but what the person wrote is never in the log line.
    expect(warn).toHaveBeenCalled();
    for (const call of warn.mock.calls) expect(JSON.stringify(call.map(String))).not.toContain("0xFEEDFACE");
    expect(rankRun).toHaveBeenCalledTimes(1);
    expect(signals[0]!.aborted).toBe(false); // the call it was ranking for was never given up on
    expect(prompts).toHaveLength(1);
    expect(text).not.toContain("tool-output-available");
    expect(text).not.toContain('"router"');
    expect(await getAccount(db, ALICE)).toMatchObject({ balance: 5_000_000n - 7_800n, held: 0n });
    expect(await settledMeta()).toMatchObject({ router: { model: "jev-1" } }); // the reading is still recorded
    expect((await settledMeta())?.router).not.toHaveProperty("speculative");
  });

  it("a turn that finds its own words while the rank read is still running keeps them", async () => {
    await applyCredit(db, { address: ALICE, amount: 5_000_000n, kind: "adjustment", ref: "seed" });
    rankRun.mockImplementationOnce(async () => { await new Promise((r) => setTimeout(r, 60)); return RANKED; });
    const { language, prompts, signals } = recorder();
    const response = await handleChat({ db, address: ALICE, body: body({ messages: [userMessage("highest APY to LP?")] }), model: { language, info }, read: async () => confident, adapters: [ranker()] });
    const text = await response.text();

    expect(rankRun).toHaveBeenCalledTimes(1); // it ran, and its answer came too late to use
    expect(signals[0]!.aborted).toBe(false);
    expect(prompts).toHaveLength(1);
    expect(text).not.toContain("tool-output-available");
    expect(text).not.toContain('"router"');
    expect(await getAccount(db, ALICE)).toMatchObject({ balance: 5_000_000n - 7_800n, held: 0n });
  }, 20_000);

  it("does not hold the reply open for a rank read the turn can no longer use", async () => {
    await applyCredit(db, { address: ALICE, amount: 5_000_000n, kind: "adjustment", ref: "seed" });
    // A rank read that has not answered by the time the model finds its own words, and does not answer during
    // this test at all. Once the turn has committed, nothing is waiting for it: the reply must be able to end.
    const pending = deferred<typeof RANKED>();
    rankRun.mockImplementationOnce(() => pending.promise);
    const { language, prompts, signals } = recorder();
    const response = await handleChat({ db, address: ALICE, body: body({ messages: [userMessage("highest APY to LP?")] }), model: { language, info }, read: async () => confident, adapters: [ranker()] });
    const text = await response.text(); // the stream ENDS while the read is still pending

    expect(rankRun).toHaveBeenCalledTimes(1);
    expect(text).toContain("DOUGH leads.");
    expect(text).not.toContain("tool-output-available");
    expect(text).not.toContain('"router"');
    expect(signals[0]!.aborted).toBe(false); // nothing was given up on: the ordinary turn simply carried on
    expect(prompts).toHaveLength(1);
    // The `finish` chunk carries the cost, so a late stream is a late settlement: both are on time here.
    expect(text).toContain('"costMicrousd":"7800"');
    expect(await getAccount(db, ALICE)).toMatchObject({ balance: 5_000_000n - 7_800n, held: 0n });
    pending.resolve(RANKED); // the orphaned read is let go of, not left pending past the test
  }, 10_000);

  it("stopping a turn while the reader and the speculative call are both pending leaves nothing held", async () => {
    await applyCredit(db, { address: ALICE, amount: 5_000_000n, kind: "adjustment", ref: "seed" });
    const { language } = recorder({ holdFirstCall: true });
    const controller = new AbortController();
    const response = await handleChat({ db, address: ALICE, body: body({ messages: [userMessage("highest APY to LP?")] }), model: { language, info }, read: () => deferred<null>().promise, adapters: [ranker()], signal: controller.signal });
    const reader = response.body!.getReader();
    expect((await getAccount(db, ALICE)).held).toBeGreaterThan(0n);
    controller.abort();
    await reader.cancel().catch(() => {});
    await vi.waitFor(async () => expect((await getAccount(db, ALICE)).held).toBe(0n), { timeout: 5_000 });
    expect(rankRun).not.toHaveBeenCalled();
  }, 20_000);

  it.each([0, 1, 2, 5])("still builds ONE assistant message when the model starts writing as the reading lands (+%ims)", async (delay) => {
    await applyCredit(db, { address: ALICE, amount: 5_000_000n, kind: "adjustment", ref: "seed" });
    // Neither side is held back, so which of them gets there first is genuinely undecided. Whichever wins, the
    // browser must be given one `start` and the chat must be left with one assistant message: that is what the
    // held-back opening chunks are for.
    const { language, prompts } = recorder();
    const response = await handleChat({ db, address: ALICE, body: body({ messages: [userMessage("highest APY to LP?")] }), model: { language, info }, read: async () => { await new Promise((r) => setTimeout(r, delay)); return confident; }, adapters: [ranker()] });
    const text = await response.text();

    expect(text.match(/"type":"start"/g)).toHaveLength(1);
    expect(text).toContain("DOUGH leads.");
    const preRan = rankRun.mock.calls.length > 0;
    expect(prompts).toHaveLength(preRan ? 2 : 1); // the reader won, or the model did; both are correct turns
    expect(text.includes('"router"')).toBe(preRan); // and the reply says so only when it really pre-ran

    await vi.waitFor(async () => expect((await getAccount(db, ALICE)).held).toBe(0n));
    const saved = (await getChat(db, { address: ALICE, chatId: response.headers.get("x-chat-id")! }))!.messages;
    expect(saved.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect((saved[1]!.parts as Array<{ type: string }>).filter((p) => p.type === "tool-rate_rank")).toHaveLength(preRan ? 1 : 0);
  }, 20_000);

  it("with no reader given, the turn reads the key from the environment itself", async () => {
    await applyCredit(db, { address: ALICE, amount: 5_000_000n, kind: "adjustment", ref: "seed" });
    vi.stubEnv("TYPESAFE_API_KEY", "sk-from-the-environment");
    vi.mocked(readRequest).mockResolvedValueOnce(confident);
    const response = await handleChat({ db, address: ALICE, body: body({ messages: [userMessage("highest APY to LP?")] }), model: { language: recorder({ holdFirstCall: true }).language, info }, adapters: [ranker()] });
    const text = await response.text();
    expect(readRequest).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "sk-from-the-environment", message: "highest APY to LP?" }));
    expect(rankRun).toHaveBeenCalledTimes(1);
    expect(text).not.toContain("sk-from-the-environment");
  });

  it("uses no reader at all when the hold had to be cut to what the account could spare", async () => {
    await applyCredit(db, { address: ALICE, amount: 150_000n, kind: "adjustment", ref: "seed" });
    const read = vi.fn(async () => confident);
    const { language, prompts } = recorder();
    const response = await handleChat({ db, address: ALICE, body: body(), model: { language, info }, read, adapters: [ranker()] });
    expect(response.status).toBe(200);
    await response.text();
    expect(read).not.toHaveBeenCalled(); // that hold covers one call, and a pre-run turn is charged for two
    expect(prompts).toHaveLength(1);
    expect(await getAccount(db, ALICE)).toMatchObject({ balance: 150_000n - 7_800n, held: 0n });
  });
});

describe("modelErrorSentence", () => {
  it("names a gateway refusal the person can act on", async () => {
    const { modelErrorSentence } = await import("./chat");
    const refused = Object.assign(new Error("Free tier users do not have access to this model. Upgrade to paid credits at https://vercel.com/…"), { statusCode: 403 });
    expect(modelErrorSentence(refused)).toBe("This model needs paid AI gateway credits. Choose another model, or add credits to the gateway.");
  });

  it("says one plain sentence for anything else, with no internals in it", async () => {
    const { modelErrorSentence } = await import("./chat");
    expect(modelErrorSentence(new Error("ECONNRESET at 10.0.0.3:443"))).toBe("The model could not answer just now. Your message is kept; try again.");
  });
});
