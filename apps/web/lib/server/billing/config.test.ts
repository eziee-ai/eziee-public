import { afterEach, describe, expect, it, vi } from "vitest";
import { marginBps, minHoldMicrousd } from "./config";

afterEach(() => vi.unstubAllEnvs());

describe("billing numbers from the environment", () => {
  it("default when unset", () => {
    vi.stubEnv("BILLING_MIN_HOLD_MICROUSD", "");
    vi.stubEnv("BILLING_MARGIN_BPS", "");
    expect(minHoldMicrousd()).toBe(10_000n);
    expect(marginBps()).toBe(3000);
  });

  it("are read when asked, not when the module loads", () => {
    vi.stubEnv("BILLING_MIN_HOLD_MICROUSD", "25000");
    vi.stubEnv("BILLING_MARGIN_BPS", "1500");
    expect(minHoldMicrousd()).toBe(25_000n);
    expect(marginBps()).toBe(1500);
  });

  it("name the variable when a value is malformed", () => {
    vi.stubEnv("BILLING_MIN_HOLD_MICROUSD", "ten cents");
    expect(() => minHoldMicrousd()).toThrow(/BILLING_MIN_HOLD_MICROUSD/);
    vi.stubEnv("BILLING_MARGIN_BPS", "200000");
    expect(() => marginBps()).toThrow(/BILLING_MARGIN_BPS/);
  });
});
