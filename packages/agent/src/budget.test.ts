import { describe, expect, it } from "vitest";
import { createBudget, estimatePromptTokens } from "./budget";
import { costMicrousd, parsePrice } from "./pricing";

const price = parsePrice({ input: "0.000003", output: "0.000015" })!;
const MARGIN = 3000;
const step = (input: number, output: number, toolResults: unknown[] = []) => ({ usage: { inputTokens: input, outputTokens: output }, toolResults: toolResults.map((output) => ({ output })) });

describe("createBudget — no step starts unless its worst case still fits in what was held", () => {
  it("lets a cheap loop run on", () => {
    const budget = createBudget({ holdMicrousd: 250_000n, price, marginBps: MARGIN, maxOutputTokens: 4096 });
    expect(budget.shouldStop([step(3_000, 100)])).toBe(false);
    expect(budget.stopped).toBe(false);
  });

  it("stops BEFORE the step that could overrun, not after it", () => {
    const budget = createBudget({ holdMicrousd: 250_000n, price, marginBps: MARGIN, maxOutputTokens: 4096 });
    // One step cost 136,500. The next would carry 23,000 tokens in and may write 4,096: worst case 169,572. Together they pass 250,000.
    expect(costMicrousd({ inputTokens: 20_000, outputTokens: 3_000 }, price, MARGIN)).toBe(136_500n);
    expect(budget.shouldStop([step(20_000, 3_000)])).toBe(true);
    expect(budget.stopped).toBe(true);
  });

  it("counts what the tools returned: that text is the next step's input", () => {
    const big = "x".repeat(120_000);
    const budget = createBudget({ holdMicrousd: 250_000n, price, marginBps: MARGIN, maxOutputTokens: 4096 });
    expect(budget.shouldStop([step(3_000, 100)])).toBe(false);
    expect(budget.shouldStop([step(3_000, 100, [{ rows: big }])])).toBe(true);
  });

  it("decides on every step so far, not only the last", () => {
    const budget = createBudget({ holdMicrousd: 250_000n, price, marginBps: MARGIN, maxOutputTokens: 4096 });
    // Each of these alone leaves room for another; together they do not.
    expect(budget.shouldStop([step(12_000, 500)])).toBe(false);
    expect(budget.shouldStop([step(12_000, 500), step(12_500, 500), step(13_000, 500)])).toBe(true);
  });

  it("records what was really spent, one finished call at a time, whether or not a stop condition ever ran", () => {
    const budget = createBudget({ holdMicrousd: 250_000n, price, marginBps: MARGIN, maxOutputTokens: 4096 });
    budget.add({ inputTokens: 1_000, outputTokens: 200 });
    budget.add({ inputTokens: 1_000, outputTokens: 200 });
    expect(budget.spent).toBe(15_600n);
  });

  it("sums the tokens of every recorded call, cache reads included", () => {
    const budget = createBudget({ holdMicrousd: 250_000n, price, marginBps: MARGIN, maxOutputTokens: 4096 });
    expect(budget.usage()).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 });
    budget.add({ inputTokens: 10, outputTokens: 5, inputTokenDetails: { cacheReadTokens: 4 } });
    budget.add({ inputTokens: 10, outputTokens: 5, inputTokenDetails: { cacheReadTokens: 4 } });
    budget.add({ outputTokens: 0 });
    expect(budget.usage()).toEqual({ inputTokens: 20, outputTokens: 10, cacheReadTokens: 8 });
  });
});

describe("estimatePromptTokens", () => {
  it("counts the instructions and every tool's description and schema, not only the messages", () => {
    const bare = estimatePromptTokens({ instructions: "", tools: {}, messages: [] });
    const full = estimatePromptTokens({ instructions: "a".repeat(3_000), tools: { t: { description: "b".repeat(600) } }, messages: [{ text: "c".repeat(300) }] });
    expect(full - bare).toBeGreaterThanOrEqual(1_000 + 200 + 100);
  });
});
