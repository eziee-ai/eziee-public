import { describe, expect, it } from "vitest";
import { costMicrousd, holdMicrousd, parsePrice, type ModelPrice } from "./pricing";

// moonshotai/kimi-k3 as the gateway listed it on 2026-09-20: USD per TOKEN, as decimal strings.
const K3: ModelPrice = parsePrice({ input: "0.000003", output: "0.000015", input_cache_read: "0.0000003" })!;

describe("parsePrice", () => {
  it("keeps sub-micro-dollar prices exact (0.57 micro-USD per token is not 0 and not 1)", () => {
    const k2 = parsePrice({ input: "0.00000057", output: "0.0000023" })!;
    expect(k2.inputPico).toBe(570_000n);
    expect(k2.outputPico).toBe(2_300_000n);
    expect(k2.cacheReadPico).toBe(570_000n); // no cache price listed: cached input is charged as input
  });

  it.each([["missing output", { input: "0.000003" }], ["a negative price", { input: "-1", output: "1" }], ["scientific notation", { input: "3e-6", output: "1" }], ["not an object", "free"], ["a zero input price", { input: "0", output: "0.00001" }]])("returns null for %s, so the model is refused rather than served unmetered", (_n, raw) => {
    expect(parsePrice(raw)).toBeNull();
  });
});

describe("costMicrousd", () => {
  it("prices input, cached input and output separately, adds the margin, and rounds UP", () => {
    // 1000 fresh in (3000) + 9000 cached (2700) + 500 out (7500) = 13200 micro-USD; +30% = 17160
    expect(costMicrousd({ inputTokens: 10_000, inputTokenDetails: { cacheReadTokens: 9_000 }, outputTokens: 500 }, K3, 3000)).toBe(17_160n);
  });

  it("rounds a fraction of a micro-dollar up, never down to free", () => {
    expect(costMicrousd({ inputTokens: 1, outputTokens: 0 }, K3, 0)).toBe(3n);
    const k2 = parsePrice({ input: "0.00000057", output: "0.0000023" })!;
    expect(costMicrousd({ inputTokens: 1, outputTokens: 0 }, k2, 0)).toBe(1n);
  });

  it("treats missing usage as zero and never returns a negative cost", () => {
    expect(costMicrousd({}, K3, 3000)).toBe(0n);
    expect(costMicrousd({ inputTokens: 5, inputTokenDetails: { cacheReadTokens: 50 }, outputTokens: undefined }, K3, 0)).toBeGreaterThanOrEqual(0n);
  });

  it("charges cache writes at their own price when the model lists one", () => {
    const sonnet = parsePrice({ input: "0.000002", output: "0.00001", input_cache_read: "0.0000002", input_cache_write: "0.0000025" })!;
    expect(costMicrousd({ inputTokens: 1000, inputTokenDetails: { cacheWriteTokens: 1000 }, outputTokens: 0 }, sonnet, 0)).toBe(2_500n);
  });
});

describe("holdMicrousd", () => {
  it("reserves the worst case: the estimated input plus the full output cap, with margin, per step", () => {
    // (20000 in × 3 + 4096 out × 15) = 121440; ×1.3 = 157872; × 8 steps
    expect(holdMicrousd(K3, { estimatedInputTokens: 20_000, maxOutputTokens: 4_096, maxSteps: 8, marginBps: 3000, minimum: 10_000n })).toBe(157_872n * 8n);
  });

  it("never reserves less than the configured minimum", () => {
    expect(holdMicrousd(K3, { estimatedInputTokens: 1, maxOutputTokens: 1, maxSteps: 1, marginBps: 0, minimum: 10_000n })).toBe(10_000n);
  });
});
