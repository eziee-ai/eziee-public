import { describe, expect, it } from "vitest";
import { chatUsage, formatTokens, latestSendFloor, replyCosts, replyLine, trimmedCount } from "./usage";

const reply = (metadata: Record<string, unknown>) => ({ role: "assistant", metadata });
const person = { role: "user", metadata: undefined };

describe("chatUsage", () => {
  it("sums what every reply used and cost, and keeps the last reply's context", () => {
    const usage = chatUsage([
      person,
      reply({ costMicrousd: "6240", usage: { inputTokens: 1200, outputTokens: 80, cacheReadTokens: 1000 }, contextTokens: 900, contextWindow: 256_000 }),
      person,
      reply({ costMicrousd: "10", usage: { inputTokens: 20, outputTokens: 5, cacheReadTokens: 0 }, contextTokens: 8_100, contextWindow: 1_000_000 }),
    ]);
    // Cache reads are part of the input already, so they are not counted twice.
    expect(usage).toEqual({ tokens: 1305, costMicrousd: 6250n, replies: 2, last: { contextTokens: 8_100, contextWindow: 1_000_000 } });
  });

  it("counts a reply saved before usage was recorded by its cost alone", () => {
    expect(chatUsage([person, reply({ costMicrousd: "7800" })])).toEqual({ tokens: 0, costMicrousd: 7800n, replies: 1 });
  });

  it("is empty for a chat with no finished reply", () => {
    expect(chatUsage([person, reply({ model: "moonshotai/kimi-k3" })])).toEqual({ tokens: 0, costMicrousd: 0n, replies: 0 });
  });

  it("ignores a cost that is not a whole number of micro-USD", () => {
    expect(chatUsage([reply({ costMicrousd: "1.5" }), reply({ costMicrousd: "-3" })]).costMicrousd).toBe(0n);
  });
});

describe("formatTokens", () => {
  it.each([
    [0, "0"],
    [340, "340"],
    [999, "999"],
    [1_000, "1.0k"],
    [1_280, "1.3k"],
    [999_949, "999.9k"],
    [999_950, "1.0M"],
    [1_000_000, "1.0M"],
    [-5, "0"],
    [Number.NaN, "0"],
  ])("%d is %s", (n, text) => {
    expect(formatTokens(n)).toBe(text);
  });
});

describe("replyLine", () => {
  it("names the model, the tokens in and out, and the cost", () => {
    expect(replyLine({ model: "moonshotai/kimi-k3", costMicrousd: "6240", usage: { inputTokens: 1200, outputTokens: 80, cacheReadTokens: 0 } })).toBe("kimi-k3 · 1.2k in · 80 out · $0.0062");
  });

  it("says only the cost when the reply has no usage", () => {
    expect(replyLine({ model: "moonshotai/kimi-k3", costMicrousd: "6240" })).toBe("kimi-k3 · this reply cost $0.0062");
  });
});

describe("trimmedCount", () => {
  it("is what the latest reply says was left out", () => {
    expect(trimmedCount([person, reply({ trimmed: 4 }), person, reply({ trimmed: 12 })])).toBe(12);
  });

  it("is 0 before any reply, and when the latest reply left nothing out", () => {
    expect(trimmedCount([person])).toBe(0);
    expect(trimmedCount([reply({ trimmed: 4 }), person, reply({ trimmed: 0 })])).toBe(0);
  });
});

describe("replyCosts", () => {
  it("lists what each finished reply cost, and skips the rest", () => {
    expect(replyCosts([person, reply({ costMicrousd: "6240" }), person, reply({ model: "m" }), reply({ costMicrousd: "10" })])).toEqual([6240n, 10n]);
  });
});

describe("latestSendFloor", () => {
  it("is what the latest reply said one send needs", () => {
    expect(latestSendFloor([reply({ sendFloorMicrousd: "90000" }), person, reply({ sendFloorMicrousd: "123162" })])).toBe(123_162n);
  });

  it("is null before any reply says so, or when what it says is not a whole number", () => {
    expect(latestSendFloor([person])).toBeNull();
    expect(latestSendFloor([reply({ costMicrousd: "1" })])).toBeNull();
    expect(latestSendFloor([reply({ sendFloorMicrousd: "9e4" })])).toBeNull();
  });
});
