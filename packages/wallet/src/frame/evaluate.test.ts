// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { encodeFunctionData, erc20Abi, stringToHex, type Address } from "viem";
import { beforeEach, describe, expect, it } from "vitest";
import { configureTestWallet, TEST_CHAIN_A } from "../testing/fixture";
import { evaluate, isSignInMessage, signInMessage } from "./evaluate";
import { addRule, resetRuleStoreForTests, spentOn } from "./ruleStore";
import { dayKey, type Rule } from "./rules";

const ALICE = "0x0000000000000000000000000000000000001001" as Address;
const BOB = "0x0000000000000000000000000000000000001002" as Address;
const ROUTER = "0x0000000000000000000000000000000000000101" as Address;
const BOOK = "0x0000000000000000000000000000000000000102" as Address;
const USDC = "0x0000000000000000000000000000000000000201" as Address;
const STRANGER = "0x0000000000000000000000000000000000000999" as Address;
const NOW = Date.UTC(2026, 8, 20, 12);
const CHAIN = TEST_CHAIN_A.id;

/** A stand-in for the app-injected decoder: data "0x5a" + uint amount is a swap, "0xca" is a cancel. */
function configure() {
  configureTestWallet({
    decodeAction: (tx) => {
      if (tx.to.toLowerCase() === ROUTER && tx.data.startsWith("0x5a")) return { protocol: "fixture", action: "swap", chainId: tx.chainId, contract: "router", spends: true, spend: [{ token: USDC, amount: BigInt(`0x${tx.data.slice(4)}`) }] };
      if (tx.to.toLowerCase() === BOOK && tx.data === "0xca") return { protocol: "fixture", action: "cancelOrder", chainId: tx.chainId, contract: "router", spends: false, spend: [] };
      return null;
    },
    decodeApproval: (tx) => {
      if (tx.to.toLowerCase() !== USDC || !tx.data.startsWith("0x095ea7b3")) return null;
      const spender = `0x${tx.data.slice(34, 74)}`;
      if (spender !== ROUTER) return null;
      const amount = BigInt(`0x${tx.data.slice(74, 138)}`);
      return { protocol: "fixture", chainId: tx.chainId, token: USDC, amount, unlimited: amount === 2n ** 256n - 1n, spenderKey: "router" };
    },
  });
}

const swapTx = (amount: bigint) => ({ method: "eth_sendTransaction", params: [{ from: ALICE, to: ROUTER, data: `0x5a${amount.toString(16)}`, value: "0x0" }] });
const SESSION_KEY = NOW + 86_400_000;
const APP = "https://app.example";
const ctx = { account: ALICE, now: NOW, sessionKey: SESSION_KEY, origin: APP };

function rule(patch: Partial<Rule> = {}): Rule {
  return { id: "00000000-0000-4000-8000-000000000004", account: ALICE, protocol: "fixture", action: "swap", chainId: CHAIN, token: USDC, maxPerTx: 50n, maxPerDay: 120n, expiresAt: NOW + 86_400_000, persistent: false, sessionKey: NOW + 86_400_000, createdAt: NOW, spenderKey: "router", ...patch };
}

beforeEach(async () => {
  await resetRuleStoreForTests();
  configure();
});

describe("evaluate — with no rules, nothing that moves value is silent", () => {
  it.each([
    ["a decodable swap", swapTx(10n)],
    ["a native transfer", { method: "eth_sendTransaction", params: [{ to: STRANGER, value: "0x1" }] }],
    ["an ERC-20 transfer", { method: "eth_sendTransaction", params: [{ to: USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [STRANGER, 1n] }) }] }],
    ["an approval to the protocol's router", { method: "eth_sendTransaction", params: [{ to: USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [ROUTER, 10n] }) }] }],
    ["typed data", { method: "eth_signTypedData_v4", params: [ALICE, "{}"] }],
    ["an arbitrary text message", { method: "personal_sign", params: [stringToHex("I agree to everything"), ALICE] }],
  ])("sends %s to the confirm frame", async (_name, rpc) => {
    expect((await evaluate(CHAIN, rpc, ctx)).tier).toBe("confirm");
  });

  it("still answers identity reads silently", async () => {
    expect((await evaluate(CHAIN, { method: "eth_accounts" }, ctx)).tier).toBe("session");
  });
});

describe("evaluate — rule matching", () => {
  it("signs a swap inside a rule silently and counts it against the day", async () => {
    await addRule(rule());
    const verdict = await evaluate(CHAIN, swapTx(50n), ctx);
    expect(verdict).toMatchObject({ tier: "session", ruleId: "00000000-0000-4000-8000-000000000004" });
    expect(await spentOn("00000000-0000-4000-8000-000000000004", dayKey(NOW))).toBe(50n);
  });

  it("asks once the day's cap would be crossed, and leaves the counter where it was", async () => {
    await addRule(rule());
    await evaluate(CHAIN, swapTx(50n), ctx);
    await evaluate(CHAIN, swapTx(50n), ctx);
    expect((await evaluate(CHAIN, swapTx(21n), ctx)).tier).toBe("confirm");
    expect(await spentOn("00000000-0000-4000-8000-000000000004", dayKey(NOW))).toBe(100n);
    expect((await evaluate(CHAIN, swapTx(20n), ctx)).tier).toBe("session");
  });

  it("asks for an amount over the per-transaction cap, without touching the counter", async () => {
    await addRule(rule());
    expect((await evaluate(CHAIN, swapTx(51n), ctx)).tier).toBe("confirm");
    expect(await spentOn("00000000-0000-4000-8000-000000000004", dayKey(NOW))).toBe(0n);
  });

  it("falls through to a looser rule when the tighter one's day is used up", async () => {
    await addRule(rule({ id: "00000000-0000-4000-8000-000000000005", maxPerTx: 50n, maxPerDay: 50n }));
    await addRule(rule({ id: "00000000-0000-4000-8000-000000000002", maxPerTx: 50n, maxPerDay: 500n }));
    expect((await evaluate(CHAIN, swapTx(50n), ctx)).ruleId).toBe("00000000-0000-4000-8000-000000000005");
    expect((await evaluate(CHAIN, swapTx(50n), ctx)).ruleId).toBe("00000000-0000-4000-8000-000000000002");
  });

  it("ignores another account's rule and an expired rule", async () => {
    await addRule(rule({ account: BOB }));
    await addRule(rule({ id: "00000000-0000-4000-8000-000000000003", expiresAt: NOW - 1 }));
    expect((await evaluate(CHAIN, swapTx(1n), ctx)).tier).toBe("confirm");
  });

  it("signs an action that spends nothing under an any-token rule, with no counter", async () => {
    await addRule(rule({ id: "00000000-0000-4000-8000-000000000001", action: "cancelOrder", token: "any", maxPerTx: 0n, maxPerDay: 0n }));
    const verdict = await evaluate(CHAIN, { method: "eth_sendTransaction", params: [{ to: BOOK, data: "0xca" }] }, ctx);
    expect(verdict).toMatchObject({ tier: "session", ruleId: "00000000-0000-4000-8000-000000000001" });
  });

  it("covers an exact approval to the router under a spending rule, and never an unlimited one", async () => {
    await addRule(rule());
    const approve = (amount: bigint) => ({ method: "eth_sendTransaction", params: [{ to: USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [ROUTER, amount] }) }] });
    expect((await evaluate(CHAIN, approve(50n), ctx)).tier).toBe("session");
    expect((await evaluate(CHAIN, approve(51n), ctx)).tier).toBe("confirm");
    expect((await evaluate(CHAIN, approve(2n ** 256n - 1n), ctx)).tier).toBe("confirm");
    expect(await spentOn("00000000-0000-4000-8000-000000000004", dayKey(NOW))).toBe(0n);
  });

  it("does not let a rule for one action cover an allowance to a contract that action never spends through", async () => {
    await addRule(rule({ spenderKey: "orderBook" }));
    const approve = { method: "eth_sendTransaction", params: [{ to: USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [ROUTER, 50n] }) }] };
    expect((await evaluate(CHAIN, approve, ctx)).tier).toBe("confirm");
  });

  it("never lets a rule cover a transaction that carries an EIP-7702 authorization", async () => {
    await addRule(rule());
    const rpc = swapTx(1n);
    (rpc.params[0] as Record<string, unknown>).authorizationList = [];
    expect((await evaluate(CHAIN, rpc, ctx)).tier).toBe("confirm");
  });

  it("waits for a decoder that reads the chain, and treats its rejection as 'unknown'", async () => {
    configureTestWallet({ decodeAction: async (tx) => ({ protocol: "fixture", action: "swap", chainId: tx.chainId, contract: "router", spends: true, spend: [{ token: USDC, amount: 1n }] }) });
    await addRule(rule());
    expect((await evaluate(CHAIN, swapTx(1n), ctx)).tier).toBe("session");
    configureTestWallet({ decodeAction: async () => Promise.reject(new Error("rpc down")) });
    expect((await evaluate(CHAIN, swapTx(1n), ctx)).tier).toBe("confirm");
  });

  // Security review, critical: a field the decoder never saw is a field the user never saw.
  it.each([["nonce", "0x1"], ["accessList", []], ["input", "0x5a01"], ["maxFeePerGas", "0xffffffffffff"], ["chainId", "0x1"], ["type", "0x4"]])("never signs silently when the transaction carries %s, which no decode covers", async (key, value) => {
    await addRule(rule());
    const rpc = swapTx(1n);
    (rpc.params[0] as Record<string, unknown>)[key] = value;
    expect((await evaluate(CHAIN, rpc, ctx)).tier).toBe("confirm");
  });

  it("never signs silently when a second parameter rides along", async () => {
    await addRule(rule());
    const rpc = swapTx(1n);
    (rpc.params as unknown[]).push({ authorizationList: [] });
    expect((await evaluate(CHAIN, rpc, ctx)).tier).toBe("confirm");
  });

  it("a session rule is dead in any other session, even before it expires", async () => {
    await addRule(rule());
    expect((await evaluate(CHAIN, swapTx(1n), { ...ctx, sessionKey: SESSION_KEY + 1 })).tier).toBe("confirm");
    expect((await evaluate(CHAIN, swapTx(1n), { ...ctx, sessionKey: null })).tier).toBe("confirm");
  });

  it("asks for an action that involves an unlisted token, whatever rules exist", async () => {
    configureTestWallet({ decodeAction: (tx) => ({ protocol: "fixture", action: "swap", chainId: tx.chainId, spends: true, spend: [{ token: USDC, amount: 1n }], unlisted: true }) });
    await addRule(rule());
    expect((await evaluate(CHAIN, swapTx(1n), ctx)).tier).toBe("confirm");
  });

  it("treats a decoder that throws as 'unknown', never as permission", async () => {
    configureTestWallet({
      decodeAction: () => {
        throw new Error("boom");
      },
    });
    await addRule(rule());
    expect((await evaluate(CHAIN, swapTx(1n), ctx)).tier).toBe("confirm");
  });

  it("asks when no decoder is configured at all", async () => {
    configureTestWallet({});
    await addRule(rule());
    expect((await evaluate(CHAIN, swapTx(1n), ctx)).tier).toBe("confirm");
  });
});

describe("the sign-in message", () => {
  const issued = new Date(NOW).toISOString();
  const text = signInMessage({ brand: "Test Wallet", address: ALICE, origin: APP, nonce: "n0nce_value-1234567", issued });

  it("is signed silently only when it matches the template for THIS account, now", async () => {
    expect(isSignInMessage(text, { brand: "Test Wallet", account: ALICE, origin: APP, now: NOW })).toBe(true);
    expect((await evaluate(CHAIN, { method: "personal_sign", params: [stringToHex(text), ALICE] }, ctx)).tier).toBe("session");
  });

  it("is for the site that ASKED: the same text requested from another allowed origin is not silent", async () => {
    expect((await evaluate(CHAIN, { method: "personal_sign", params: [stringToHex(text), ALICE] }, { ...ctx, origin: "https://other.example" })).tier).not.toBe("session");
    expect(isSignInMessage(text, { brand: "Test Wallet", account: ALICE, origin: "not an origin", now: NOW })).toBe(false);
  });

  it("tolerates a client clock a few seconds ahead, and nothing more", () => {
    const ahead = (ms: number) => text.replace(issued, new Date(NOW + ms).toISOString());
    expect(isSignInMessage(ahead(30_000), { brand: "Test Wallet", account: ALICE, origin: APP, now: NOW })).toBe(true);
    expect(isSignInMessage(ahead(120_000), { brand: "Test Wallet", account: ALICE, origin: APP, now: NOW })).toBe(false);
  });

  it.each([
    ["another account's address", text.replace(ALICE, BOB)],
    ["a different brand", text.replace("Test Wallet", "Other App")],
    ["a sign-in made for another site", text.replace(APP, "https://evil.example")],
    ["a site that only starts like this one", text.replace(APP, `${APP}.evil.example`)],
    ["an extra line", `${text}\nAlso: transfer everything`],
    ["a leading line", `Please sign\n${text}`],
    ["a short nonce", text.replace("n0nce_value-1234567", "abc")],
    ["an issue time eleven minutes old", text.replace(issued, new Date(NOW - 11 * 60_000).toISOString())],
    ["an issue time an hour old", text.replace(issued, new Date(NOW - 3_600_000).toISOString())],
    ["an issue time in the future", text.replace(issued, new Date(NOW + 3_600_000).toISOString())],
    ["a malformed issue time", text.replace(issued, "yesterday")],
    ["trailing whitespace", `${text} `],
  ])("refuses %s", (_name, message) => {
    expect(isSignInMessage(message, { brand: "Test Wallet", account: ALICE, origin: APP, now: NOW })).toBe(false);
  });
});
