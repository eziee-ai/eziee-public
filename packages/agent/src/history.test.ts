import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { contextBudget, trimHistory } from "./history";

const user = (id: string, text = "x".repeat(10)): UIMessage => ({ id, role: "user", parts: [{ type: "text", text }] });
const reply = (id: string, text = "x".repeat(10)): UIMessage => ({ id, role: "assistant", parts: [{ type: "text", text }] });
const toolReply = (id: string): UIMessage => ({ id, role: "assistant", parts: [{ type: "step-start" }, { type: "tool-rate_balances", toolCallId: `c-${id}`, state: "output-available", input: {}, output: { rows: [] } } as never, { type: "text", text: "x".repeat(10) }] });
/** One token per message: easy to count by hand. */
const count = (messages: UIMessage[]) => messages.length;
const ids = (messages: UIMessage[]) => messages.map((m) => m.id);

describe("trimHistory", () => {
  it("drops nothing when the whole history fits", () => {
    const messages = [user("u1"), reply("a1"), user("u2")];
    expect(trimHistory({ messages, maxTokens: 3, estimate: count })).toEqual({ messages, dropped: 0 });
  });

  it("drops the oldest turns first, and the kept history starts on a person's message", () => {
    const messages = [user("u1"), reply("a1"), user("u2"), reply("a2"), user("u3")];
    // Four would fit, but a cut after u1 would start on a reply. The next place a cut may land is u2.
    const trimmed = trimHistory({ messages, maxTokens: 4, estimate: count });
    expect(ids(trimmed.messages)).toEqual(["u2", "a2", "u3"]);
    expect(trimmed.dropped).toBe(2);
  });

  it("never drops the last message, even when it is a reply being continued", () => {
    const messages = [user("u1"), reply("a1"), user("u2"), toolReply("a2")];
    const trimmed = trimHistory({ messages, maxTokens: 2, estimate: count });
    expect(ids(trimmed.messages)).toEqual(["u2", "a2"]);
    expect(trimmed.dropped).toBe(2);
  });

  it("keeps an oversize last turn anyway, and says everything before it was dropped", () => {
    const messages = [user("u1"), reply("a1"), user("u2"), reply("a2"), user("u3", "x".repeat(1_000))];
    const trimmed = trimHistory({ messages, maxTokens: 50, estimate: (m) => JSON.stringify(m).length });
    expect(ids(trimmed.messages)).toEqual(["u3"]);
    expect(trimmed.dropped).toBe(4);
  });

  it("drops a reply with a tool call together with the message it answered, so a call is never split from its result", () => {
    const messages = [user("u1"), toolReply("a1"), user("u2"), reply("a2"), user("u3")];
    const trimmed = trimHistory({ messages, maxTokens: 4, estimate: count });
    expect(ids(trimmed.messages)).toEqual(["u2", "a2", "u3"]);
    expect(trimmed.messages.some((m) => m.parts.some((p) => p.type.startsWith("tool-")))).toBe(false);
  });

  it("finds the longest history that fits in a long chat", () => {
    const messages = Array.from({ length: 1_000 }, (_, i) => (i % 2 === 0 ? user(`u${i}`) : reply(`a${i}`)));
    const trimmed = trimHistory({ messages, maxTokens: 101, estimate: count });
    expect(trimmed.messages).toHaveLength(100);
    expect(trimmed.messages[0]?.role).toBe("user");
    expect(trimmed.dropped).toBe(900);
  });

  it("with no message from the person at all, drops nothing", () => {
    const messages = [reply("a1"), reply("a2")];
    expect(trimHistory({ messages, maxTokens: 1, estimate: count })).toEqual({ messages, dropped: 0 });
  });
});

describe("contextBudget", () => {
  it("is the window less what is reserved, capped at 200k", () => {
    expect(contextBudget(128_000, 10_000)).toBe(118_000);
    expect(contextBudget(1_000_000, 10_000)).toBe(190_000);
  });

  it("never promises more than the window leaves, and never less than nothing", () => {
    expect(contextBudget(8_000, 5_000)).toBe(3_000);
    expect(contextBudget(8_000, 10_000)).toBe(0);
  });
});
