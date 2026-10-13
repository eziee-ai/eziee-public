// @vitest-environment jsdom
import "fake-indexeddb/auto";
import type { Address, Hex } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { configureTestWallet, TEST_CHAIN_A } from "../testing/fixture";
import { allowAlways } from "./allow";
import { listRules, resetRuleStoreForTests, spentOn } from "./ruleStore";
import { dayKey, type Rule } from "./rules";

const ALICE = "0x0000000000000000000000000000000000001001" as Address;
const BOB = "0x0000000000000000000000000000000000001002" as Address;
const ROUTER = "0x0000000000000000000000000000000000000101" as Address;
const USDC = "0x0000000000000000000000000000000000000201" as Address;
const WETH = "0x0000000000000000000000000000000000000202" as Address;
const NOW = Date.UTC(2026, 8, 20, 12);
const SESSION_END = NOW + 86_400_000;
const CHAIN = TEST_CHAIN_A.id;

const swapRpc = (amount: bigint) => ({ method: "eth_sendTransaction", params: [{ to: ROUTER, data: `0x5a${amount.toString(16)}`, value: "0x0" }] });
const draft = (patch: Partial<Rule> = {}): Rule => ({ id: "00000000-0000-4000-8000-000000000001", account: ALICE, protocol: "fixture", action: "swap", chainId: CHAIN, token: USDC, maxPerTx: 50n, maxPerDay: 200n, expiresAt: SESSION_END, persistent: false, sessionKey: SESSION_END, createdAt: NOW, spenderKey: "router", ...patch });
const session = { account: ALICE, expiresAt: SESSION_END, now: NOW };

let sign: ReturnType<typeof vi.fn<(chainId: number, rpc: unknown) => Promise<Hex>>>;

beforeEach(async () => {
  await resetRuleStoreForTests();
  sign = vi.fn(async () => "0xhash" as Hex);
  configureTestWallet({
    decodeAction: (tx) => (tx.to.toLowerCase() === ROUTER && tx.data.startsWith("0x5a") ? { protocol: "fixture", action: "swap", chainId: tx.chainId, contract: "router", spends: true, spend: [{ token: USDC, amount: BigInt(`0x${tx.data.slice(4)}`) }] } : null),
  });
});

describe("allowAlways", () => {
  it("saves the rule, counts this first spend against it, then signs", async () => {
    expect(await allowAlways(CHAIN, swapRpc(50n), draft(), session, sign)).toBe("0xhash");
    expect((await listRules()).map((r) => r.id)).toEqual(["00000000-0000-4000-8000-000000000001"]);
    expect(await spentOn("00000000-0000-4000-8000-000000000001", dayKey(NOW))).toBe(50n);
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a rule for a different token than the transaction spends", draft({ token: WETH })],
    ["a rule for a different action", draft({ action: "addLiquidity" })],
    ["a rule for a different protocol", draft({ protocol: "other" })],
    ["a rule for a different chain", draft({ chainId: 900002 })],
    ["a rule for another account", draft({ account: BOB })],
    ["a per-transaction limit below this very transaction", draft({ maxPerTx: 49n, maxPerDay: 200n })],
    ["a rule that fails validation", draft({ maxPerDay: 10n })],
    ["a session rule stamped for a different session", draft({ sessionKey: SESSION_END - 1 })],
    ["an id that is not a UUID", draft({ id: "r1" })],
    ["an any-token rule for an action that spends", draft({ token: "any", maxPerTx: 0n, maxPerDay: 0n })],
  ])("refuses %s, saving nothing and signing nothing", async (_name, rule) => {
    await expect(allowAlways(CHAIN, swapRpc(50n), rule, session, sign)).rejects.toMatchObject({ code: -32602 });
    expect(await listRules()).toEqual([]);
    expect(sign).not.toHaveBeenCalled();
  });

  it("refuses a transaction the frame's own decoder does not recognise, whatever the page claims", async () => {
    const rpc = { method: "eth_sendTransaction", params: [{ to: WETH, data: "0x5a01" }] };
    await expect(allowAlways(CHAIN, rpc, draft(), session, sign)).rejects.toMatchObject({ code: -32602 });
    expect(await listRules()).toEqual([]);
  });

  it("refuses a transfer even if a decoder were to recognise it: the static floor comes first", async () => {
    const rpc = { method: "eth_sendTransaction", params: [{ to: ROUTER, value: "0x1" }] };
    await expect(allowAlways(CHAIN, rpc, draft(), session, sign)).rejects.toMatchObject({ code: -32602 });
  });

  it("refuses a transaction carrying a field the decode never saw", async () => {
    const rpc = swapRpc(50n);
    (rpc.params[0] as Record<string, unknown>).nonce = "0x7";
    await expect(allowAlways(CHAIN, rpc, draft(), session, sign)).rejects.toMatchObject({ code: -32602 });
    expect(await listRules()).toEqual([]);
  });

  it("refuses a rule that names a different contract than the one this action calls, since that is the contract its approvals would go to", async () => {
    await expect(allowAlways(CHAIN, swapRpc(50n), { ...draft(), spenderKey: "somewhereElse" }, session, sign)).rejects.toMatchObject({ code: -32602 });
    expect(await listRules()).toEqual([]);
    expect(sign).not.toHaveBeenCalled();
  });

  it("refuses to make a rule for an action that involves an unlisted token", async () => {
    configureTestWallet({ decodeAction: (tx) => ({ protocol: "fixture", action: "swap", chainId: tx.chainId, spends: true, spend: [{ token: USDC, amount: 50n }], unlisted: true }) });
    await expect(allowAlways(CHAIN, swapRpc(50n), draft(), session, sign)).rejects.toMatchObject({ code: -32602 });
    expect(await listRules()).toEqual([]);
  });

  it("keeps the rule when signing fails, because the user did choose it", async () => {
    sign.mockRejectedValueOnce(new Error("rpc down"));
    await expect(allowAlways(CHAIN, swapRpc(50n), draft(), session, sign)).rejects.toThrow("rpc down");
    expect(await listRules()).toHaveLength(1);
  });
});
