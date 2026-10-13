import { describe, expect, it } from "vitest";
import { dayKey, matchAction, matchApproval, validateRule, type DecodedForRules, type Rule, type RuleMatchContext } from "./rules";

const ALICE = "0x0000000000000000000000000000000000001001";
const BOB = "0x0000000000000000000000000000000000001002";
const USDC = "0x0000000000000000000000000000000000000201";
const WETH = "0x0000000000000000000000000000000000000202";
const NOW = Date.UTC(2026, 8, 20, 12, 0, 0);
const HOUR = 3_600_000;
const SESSION_END = NOW + 24 * HOUR;

function rule(patch: Partial<Rule> = {}): Rule {
  return { id: "00000000-0000-4000-8000-000000000001", account: ALICE, sessionKey: SESSION_END, protocol: "rate", action: "swap", chainId: 5042002, token: USDC, maxPerTx: 50_000_000n, maxPerDay: 200_000_000n, expiresAt: SESSION_END, persistent: false, createdAt: NOW, spenderKey: "swapRouter", ...patch };
}

function swap(amount: bigint, patch: Partial<DecodedForRules> = {}): DecodedForRules {
  return { protocol: "rate", action: "swap", chainId: 5042002, contract: "swapRouter", spends: true, spend: [{ token: USDC, amount }], ...patch };
}

describe("validateRule", () => {
  const ctx = { now: NOW, sessionExpiresAt: SESSION_END, chainIds: [5042002, 11155931], spends: true };

  it("accepts a spending rule that names one token with positive caps", () => {
    expect(validateRule(rule(), ctx)).toBeNull();
  });

  it("accepts an any-token rule only for an action that spends nothing, with zero caps", () => {
    const cancel = rule({ action: "cancelOrder", token: "any", maxPerTx: 0n, maxPerDay: 0n });
    expect(validateRule(cancel, { ...ctx, spends: false })).toBeNull();
    expect(validateRule(cancel, ctx)).toMatch(/spends/);
    expect(validateRule(rule({ action: "cancelOrder", token: "any" }), { ...ctx, spends: false })).toMatch(/zero/);
  });

  it.each([
    ["a zero per-transaction cap on a spending rule", { maxPerTx: 0n }, /per transaction/],
    ["a daily cap below the per-transaction cap", { maxPerDay: 10n }, /per day/],
    ["a cap above uint256", { maxPerTx: 2n ** 256n, maxPerDay: 2n ** 256n }, /too large/],
    ["a negative cap", { maxPerTx: -1n }, /per transaction/],
    ["an expiry in the past", { expiresAt: NOW - 1 }, /expire/],
    ["a session rule that outlives the session", { expiresAt: SESSION_END + 1 }, /session/],
    ["a persistent rule longer than 30 days", { persistent: true, sessionKey: null, expiresAt: NOW + 31 * 24 * HOUR }, /30 days/],
    ["a chain the wallet does not serve", { chainId: 1 }, /chain/],
    ["an empty protocol", { protocol: "" }, /protocol/],
    ["a protocol with characters outside the id alphabet", { protocol: "Rate!" }, /protocol/],
    ["an action with characters outside the name alphabet", { action: "swap now" }, /action/],
    ["a malformed token", { token: "0x123" as Rule["token"] }, /token/],
    ["a malformed account", { account: "0xabc" as Rule["account"] }, /account/],
  ])("refuses %s", (_name, patch, message) => {
    expect(validateRule(rule(patch), ctx)).toMatch(message);
  });

  it("lets a persistent rule outlive the session", () => {
    expect(validateRule(rule({ persistent: true, sessionKey: null, expiresAt: NOW + 7 * 24 * HOUR }), ctx)).toBeNull();
  });
});

describe("matchAction", () => {
  it("matches a swap inside the per-transaction cap", () => {
    expect(matchAction([rule()], swap(50_000_000n), { account: ALICE, now: NOW, sessionKey: SESSION_END }).map((r) => r.id)).toEqual(["00000000-0000-4000-8000-000000000001"]);
  });

  it.each([
    ["one base unit over the per-transaction cap", swap(50_000_001n)],
    ["a different protocol", swap(1n, { protocol: "other" })],
    ["a different action", swap(1n, { action: "addLiquidity" })],
    ["a different chain", swap(1n, { chainId: 11155931 })],
    ["a different token", swap(1n, { spend: [{ token: WETH, amount: 1n }] })],
    ["the native asset, against a token rule", swap(1n, { spend: [{ token: "native", amount: 1n }] })],
    ["two spends in one action", swap(1n, { spend: [{ token: USDC, amount: 1n }, { token: WETH, amount: 1n }] })],
    ["a spending action that declares no spend", swap(1n, { spend: [] })],
    ["a zero-amount spend", swap(0n)],
  ])("does not match %s", (_name, decoded) => {
    expect(matchAction([rule()], decoded, { account: ALICE, now: NOW, sessionKey: SESSION_END })).toEqual([]);
  });

  it("does not match another account's rule", () => {
    expect(matchAction([rule()], swap(1n), { account: BOB, now: NOW, sessionKey: SESSION_END })).toEqual([]);
  });

  it("does not match at or after expiry", () => {
    expect(matchAction([rule()], swap(1n), { account: ALICE, now: SESSION_END, sessionKey: SESSION_END })).toEqual([]);
    expect(matchAction([rule()], swap(1n), { account: ALICE, now: SESSION_END - 1, sessionKey: SESSION_END })).toHaveLength(1);
  });

  it("compares token addresses without regard to case", () => {
    expect(matchAction([rule({ token: USDC.toUpperCase().replace("0X", "0x") as Rule["token"] })], swap(1n), { account: ALICE, now: NOW, sessionKey: SESSION_END })).toHaveLength(1);
  });

  it("matches a native-token rule against a native spend", () => {
    const native = rule({ token: "native", maxPerTx: 10n ** 16n, maxPerDay: 10n ** 17n });
    expect(matchAction([native], swap(10n ** 16n, { spend: [{ token: "native", amount: 10n ** 16n }] }), { account: ALICE, now: NOW, sessionKey: SESSION_END })).toHaveLength(1);
  });

  it("never lets an any-token rule cover an action that spends", () => {
    const any = rule({ token: "any", maxPerTx: 0n, maxPerDay: 0n });
    expect(matchAction([any], swap(1n), { account: ALICE, now: NOW, sessionKey: SESSION_END })).toEqual([]);
  });

  it("matches an action that spends nothing against an any-token or a token rule for it", () => {
    const cancel: DecodedForRules = { protocol: "rate", action: "cancelOrder", chainId: 5042002, contract: "swapRouter", spends: false, spend: [] };
    expect(matchAction([rule({ action: "cancelOrder", token: "any", maxPerTx: 0n, maxPerDay: 0n })], cancel, { account: ALICE, now: NOW, sessionKey: SESSION_END })).toHaveLength(1);
    // Claimed non-spending but carrying a spend is contradictory: never silent.
    expect(matchAction([rule({ action: "cancelOrder", token: "any", maxPerTx: 0n, maxPerDay: 0n })], { ...cancel, spend: [{ token: USDC, amount: 1n }] }, { account: ALICE, now: NOW, sessionKey: SESSION_END })).toEqual([]);
  });

  it("covers only the contract the rule was made on: a router swap rule does not cover a swap on the order book", () => {
    const at: RuleMatchContext = { account: ALICE, now: NOW, sessionKey: SESSION_END };
    expect(matchAction([rule()], swap(1n), at)).toHaveLength(1);
    expect(matchAction([rule()], swap(1n, { contract: "matchingEngine" }), at)).toEqual([]);
    // A rule saved before contracts were recorded covers nothing: it asks again rather than guessing.
    expect(matchAction([rule({ spenderKey: undefined })], swap(1n), at)).toEqual([]);
  });

  it("returns the tightest matching rule first", () => {
    const loose = rule({ id: "00000000-0000-4000-8000-00000000000a", maxPerTx: 100_000_000n, maxPerDay: 1_000_000_000n });
    const tight = rule({ id: "00000000-0000-4000-8000-00000000000b", maxPerTx: 30_000_000n, maxPerDay: 60_000_000n });
    expect(matchAction([loose, tight], swap(10_000_000n), { account: ALICE, now: NOW, sessionKey: SESSION_END }).map((r) => r.id)).toEqual(["00000000-0000-4000-8000-00000000000b", "00000000-0000-4000-8000-00000000000a"]);
  });
});

describe("review findings", () => {
  const at = { account: ALICE as `0x${string}`, now: NOW, sessionKey: SESSION_END };

  it("a session rule does not survive into a NEW session, even before its expiry and even if clearing it failed", () => {
    expect(matchAction([rule()], swap(1n), { ...at, sessionKey: SESSION_END + 5 })).toEqual([]);
    expect(matchAction([rule()], swap(1n), { ...at, sessionKey: null })).toEqual([]);
    expect(matchAction([rule({ persistent: true, sessionKey: null })], swap(1n), { ...at, sessionKey: SESSION_END + 5 })).toHaveLength(1);
  });

  it("never matches an action that involves a token off the protocol's list", () => {
    expect(matchAction([rule()], swap(1n, { unlisted: true }), at)).toEqual([]);
  });

  it("never matches a swap that accepts nothing in return", () => {
    expect(matchAction([rule()], swap(1n, { receive: { minAmount: 0n } }), at)).toEqual([]);
    expect(matchAction([rule()], swap(1n, { receive: { minAmount: 1n } }), at)).toHaveLength(1);
    // No minimum declared at all (a resting limit order): the price is in the order, not here.
    expect(matchAction([rule()], swap(1n, { receive: {} }), at)).toHaveLength(1);
  });

  it("refuses a rule whose id is not a UUID, because counters are keyed by id prefix", () => {
    expect(validateRule(rule({ id: "a" }), { now: NOW, sessionExpiresAt: SESSION_END, chainIds: [5042002], spends: true })).toMatch(/id/);
  });

  it("refuses a session rule that is not bound to the current session", () => {
    expect(validateRule(rule({ sessionKey: null }), { now: NOW, sessionExpiresAt: SESSION_END, chainIds: [5042002], spends: true })).toMatch(/session/);
    expect(validateRule(rule({ sessionKey: 123 }), { now: NOW, sessionExpiresAt: SESSION_END, chainIds: [5042002], spends: true })).toMatch(/session/);
  });
});

describe("an action marked always-ask", () => {
  it("is never covered by a rule, whatever the rule says", () => {
    const decoded: DecodedForRules = { protocol: "rate", action: "removeLiquidity", chainId: 5042002, spends: false, spend: [], alwaysAsk: true };
    expect(matchAction([rule({ action: "removeLiquidity", token: "any", maxPerTx: 0n, maxPerDay: 0n })], decoded, { account: ALICE, now: NOW, sessionKey: SESSION_END })).toEqual([]);
  });
});

describe("matchApproval", () => {
  const approval = { protocol: "rate", chainId: 5042002, token: USDC as Rule["account"], amount: 50_000_000n, unlimited: false, spenderKey: "swapRouter" };

  it("covers an exact approval inside a spending rule for that protocol and token", () => {
    expect(matchApproval([rule()], approval, { account: ALICE, now: NOW, sessionKey: SESSION_END })).toBe(true);
  });

  it.each([
    ["an unlimited approval", { unlimited: true }],
    ["an approval above the per-transaction cap", { amount: 50_000_001n }],
    ["a zero approval, which is a revocation and needs no rule to be asked about", { amount: 0n }],
    ["another protocol's router", { protocol: "other" }],
    ["another token", { token: WETH as Rule["account"] }],
    ["another chain", { chainId: 11155931 }],
    ["an allowance to ANOTHER contract of the same protocol, which this rule's action never spends through", { spenderKey: "positionManager" }],
    ["a token off the reviewed list (a launch coin), whatever the rule says", { listed: false }],
  ])("does not cover %s", (_name, patch) => {
    expect(matchApproval([rule()], { ...approval, ...patch }, { account: ALICE, now: NOW, sessionKey: SESSION_END })).toBe(false);
  });

  it("a rule saved before rules named their contract covers no approval: the wallet asks", () => {
    expect(matchApproval([rule({ spenderKey: undefined })], approval, { account: ALICE, now: NOW, sessionKey: SESSION_END })).toBe(false);
  });

  it("is not covered by an any-token rule, another account's rule, or an expired rule", () => {
    expect(matchApproval([rule({ token: "any", maxPerTx: 0n, maxPerDay: 0n })], approval, { account: ALICE, now: NOW, sessionKey: SESSION_END })).toBe(false);
    expect(matchApproval([rule()], approval, { account: BOB, now: NOW, sessionKey: SESSION_END })).toBe(false);
    expect(matchApproval([rule()], approval, { account: ALICE, now: SESSION_END, sessionKey: SESSION_END })).toBe(false);
  });
});

describe("dayKey", () => {
  it("is the UTC calendar day, so a cap resets at one unambiguous moment", () => {
    expect(dayKey(Date.UTC(2026, 8, 20, 23, 59, 59, 999))).toBe("2026-09-20");
    expect(dayKey(Date.UTC(2026, 8, 21, 0, 0, 0, 0))).toBe("2026-09-21");
  });
});
