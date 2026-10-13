import { describe, expect, it } from "vitest";
import { checkTopUp, depositNeeded, pollDelayMs, STALE_AFTER_MS } from "./topUp";

describe("checkTopUp", () => {
  const usdc = { decimals: 6, held: 100_000_000n, maxMicrousd: 500_000_000n };

  it("accepts a plain amount the wallet holds, as exact base units", () => {
    expect(checkTopUp("12.5", usdc)).toEqual({ ok: true, amount: 12_500_000n, text: "12.5" });
  });

  it.each([
    ["nothing", "", /amount/i],
    ["zero", "0", /greater than zero/i],
    ["more decimals than USDC has", "1.0000001", /decimal/i],
    ["more than the wallet holds", "100.000001", /holds 100 USDC/],
    ["more than one top-up may be credited for, BEFORE the money is sent rather than after", "500.01", /most one top-up/],
  ])("refuses %s", (_name, input, message) => {
    const held = input === "500.01" ? 10n ** 12n : usdc.held;
    const result = checkTopUp(input, { ...usdc, held });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(message);
  });

  it("does not block on a balance it has not been told yet", () => {
    expect(checkTopUp("5", { ...usdc, held: undefined }).ok).toBe(true);
  });

  it("scales the cap to a token that is not six decimals", () => {
    expect(checkTopUp("500", { decimals: 18, held: undefined, maxMicrousd: 500_000_000n }).ok).toBe(true);
    expect(checkTopUp("500.000000000000000001", { decimals: 18, held: undefined, maxMicrousd: 500_000_000n }).ok).toBe(false);
  });
});

describe("pollDelayMs — how soon to ask the server about a deposit again", () => {
  it("asks every few seconds while it confirms, then eases off for one that is taking long", () => {
    expect(pollDelayMs({ settled: false, failures: 0, ageMs: 10_000 })).toBe(4_000);
    expect(pollDelayMs({ settled: false, failures: 0, ageMs: STALE_AFTER_MS + 1 })).toBe(30_000);
  });

  it("backs off after failures, up to a minute, and obeys a server that says when to come back", () => {
    expect(pollDelayMs({ settled: false, failures: 1, ageMs: 0 })).toBe(8_000);
    expect(pollDelayMs({ settled: false, failures: 3, ageMs: 0 })).toBe(32_000);
    expect(pollDelayMs({ settled: false, failures: 9, ageMs: 0 })).toBe(60_000);
    expect(pollDelayMs({ settled: false, failures: 1, ageMs: 0, retryAfterSeconds: 45 })).toBe(45_000);
  });

  it("stops once the deposit is credited or refused", () => {
    expect(pollDelayMs({ settled: true, failures: 0, ageMs: 0 })).toBe(false);
  });
});

describe("depositNeeded", () => {
  const usdc = { decimals: 6, maxMicrousd: 500_000_000n };

  it("says so when the wallet holds no USDC at all", () => {
    expect(depositNeeded("5", { ...usdc, held: 0n })).toBe("empty");
  });

  it("says so when the wallet holds less than the amount", () => {
    expect(depositNeeded("5", { ...usdc, held: 4_999_999n })).toBe("short");
  });

  it("is quiet when the wallet holds enough, or before the balance is known", () => {
    expect(depositNeeded("5", { ...usdc, held: 5_000_000n })).toBeNull();
    expect(depositNeeded("5", { ...usdc, held: undefined })).toBeNull();
  });

  it("does not blame the balance for an amount that is wrong for another reason", () => {
    expect(depositNeeded("abc", { ...usdc, held: 1_000_000n })).toBeNull();
    expect(depositNeeded("600", { ...usdc, held: 1_000_000n })).toBeNull();
  });
});

describe("checkTopUp for a token priced by the operator", () => {
  // 1 EZT buys a cent; a $500 cap is 50,000 EZT.
  const ezt = { decimals: 18, held: 10n ** 30n, maxMicrousd: 500_000_000n, symbol: "EZT", microusdPerToken: 10_000n };

  it("converts the cap at the token's price, and names the token", () => {
    expect(checkTopUp("50000", ezt).ok).toBe(true);
    expect(checkTopUp("50000.000000000000000001", ezt)).toMatchObject({ ok: false, message: expect.stringMatching(/\$500/) });
    expect(checkTopUp("5", { ...ezt, held: 10n ** 18n })).toMatchObject({ ok: false, message: expect.stringMatching(/holds 1 EZT/) });
    // 0.00001 EZT is a tenth of a micro-dollar: it would reach the treasury and buy nothing.
    expect(checkTopUp("0.00001", ezt)).toMatchObject({ ok: false, message: expect.stringMatching(/too little EZT/) });
  });
});
