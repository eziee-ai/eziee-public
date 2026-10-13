import { describe, expect, it } from "vitest";
import { draftRule, parseCap, ruleEligibility } from "./scope";
import { validateRule, type DecodedForRules } from "./rules";

const ALICE = "0x0000000000000000000000000000000000001001";
const USDC = "0x0000000000000000000000000000000000000201";
const WETH = "0x0000000000000000000000000000000000000202";
const NOW = Date.UTC(2026, 8, 20, 12);
const SESSION_END = NOW + 86_400_000;
const swap: DecodedForRules = { protocol: "rate", action: "swap", chainId: 5042002, spends: true, spend: [{ token: USDC, amount: 50_000_000n }] };
const cancel: DecodedForRules = { protocol: "rate", action: "cancelOrder", chainId: 5042002, spends: false, spend: [] };

describe("ruleEligibility", () => {
  it("offers a rule for one-token spends and for actions that spend nothing", () => {
    expect(ruleEligibility(swap)).toEqual({ eligible: true });
    expect(ruleEligibility(cancel)).toEqual({ eligible: true });
  });

  it.each([
    ["nothing was decoded", null],
    ["two tokens are spent", { ...swap, spend: [...swap.spend, { token: WETH, amount: 1n }] }],
    ["a spending action declares no spend", { ...swap, spend: [] }],
    ["a non-spending action carries a spend", { ...cancel, spend: swap.spend }],
    ["a token is off the protocol's list", { ...swap, unlisted: true }],
    ["nothing is accepted in return", { ...swap, receive: { minAmount: 0n } }],
  ])("offers none when %s, and says why", (_name, decoded) => {
    const result = ruleEligibility(decoded as DecodedForRules | null);
    expect(result.eligible).toBe(false);
    expect(!result.eligible && result.reason.length).toBeGreaterThan(10);
  });
});

describe("draftRule", () => {
  const ctx = { id: "00000000-0000-4000-8000-000000000001", account: ALICE as `0x${string}`, now: NOW, sessionExpiresAt: SESSION_END };

  it("prefills from the action: this token, this amount per transaction, four times that per day, until the session ends", () => {
    const draft = draftRule(swap, ctx);
    expect(draft).toMatchObject({ id: "00000000-0000-4000-8000-000000000001", sessionKey: SESSION_END, account: ALICE, protocol: "rate", action: "swap", chainId: 5042002, token: USDC, maxPerTx: 50_000_000n, maxPerDay: 200_000_000n, expiresAt: SESSION_END, persistent: false, createdAt: NOW });
    expect(validateRule(draft, { now: NOW, sessionExpiresAt: SESSION_END, chainIds: [5042002], spends: true })).toBeNull();
  });

  it("drafts an any-token rule with zero limits for an action that spends nothing", () => {
    const draft = draftRule(cancel, ctx);
    expect(draft).toMatchObject({ token: "any", maxPerTx: 0n, maxPerDay: 0n });
    expect(validateRule(draft, { now: NOW, sessionExpiresAt: SESSION_END, chainIds: [5042002], spends: false })).toBeNull();
  });
});

describe("parseCap", () => {
  it("parses a plain decimal into exact base units", () => {
    expect(parseCap("50", 6)).toBe(50_000_000n);
    expect(parseCap("0.5", 6)).toBe(500_000n);
    expect(parseCap(" 200 ", 6)).toBe(200_000_000n);
  });

  it.each([["empty", ""], ["zero", "0"], ["a sign", "-5"], ["an exponent", "1e9"], ["too many decimals", "0.0000001"], ["text", "lots"], ["a separator", "1,000"]])("returns null for %s", (_n, text) => {
    expect(parseCap(text, 6)).toBeNull();
  });
});
