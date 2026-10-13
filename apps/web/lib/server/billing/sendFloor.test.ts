import { afterEach, describe, expect, it, vi } from "vitest";
import { parsePrice } from "@repo/agent/pricing";
import { defaultSendFloor, SEND_FLOOR_PROMPT_TOKENS } from "./sendFloor";

const price = parsePrice({ input: "0.000003", output: "0.000015" })!;
afterEach(() => vi.unstubAllEnvs());

describe("defaultSendFloor", () => {
  it("is one worst-case call of the default model at a first message's prompt size, with the margin", async () => {
    vi.stubEnv("BILLING_MARGIN_BPS", "");
    vi.stubEnv("BILLING_MIN_HOLD_MICROUSD", "");
    expect(SEND_FLOOR_PROMPT_TOKENS).toBe(12_000);
    // (12,000 × 3 + 4,096 × 15) × 1.3 = 126,672 micro-USD.
    expect(await defaultSendFloor({ price: async () => price })).toBe(126_672n);
  });

  it("is never below the minimum hold", async () => {
    vi.stubEnv("BILLING_MIN_HOLD_MICROUSD", "500000");
    expect(await defaultSendFloor({ price: async () => price })).toBe(500_000n);
  });

  it("is null when the price cannot be had in time, or at all, or a billing value is malformed", async () => {
    expect(await defaultSendFloor({ price: () => new Promise(() => {}), waitMs: 10 })).toBeNull();
    expect(await defaultSendFloor({ price: async () => null })).toBeNull();
    expect(await defaultSendFloor({ price: async () => { throw new Error("gateway down"); } })).toBeNull();
    vi.stubEnv("BILLING_MARGIN_BPS", "lots");
    expect(await defaultSendFloor({ price: async () => price })).toBeNull();
  });
});
