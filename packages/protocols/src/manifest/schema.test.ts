import { describe, expect, it } from "vitest";
import { ProtocolError } from "../errors";
import { ADDR, FIXTURE_CHAIN_ID, fixtureManifest } from "../testing/fixture";
import { parseManifest } from "./schema";

type Mutable = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function broken(mutate: (m: Mutable) => void): Mutable {
  const m = fixtureManifest() as Mutable;
  mutate(m);
  return m;
}

describe("parseManifest", () => {
  it("refuses Rate's former id: rules and chats saved under \"iter\" are read as Rate's", () => {
    expect(() => parseManifest({ ...fixtureManifest(), id: "iter" })).toThrow(/reserved/);
  });

  it("accepts an address input that is explicitly ignored with a reviewable reason", () => {
    const m = fixtureManifest() as Mutable;
    m.actions.swap.calls[0].abi = "function swapExactIn(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address to, uint256 deadline, address referrer)";
    m.actions.swap.calls[0].ignore = [{ arg: "referrer", reason: "Referral tag only. The router never sends funds to it." }];
    expect(() => parseManifest(m)).not.toThrow();
  });

  it("demands that a call which spends nothing still explains every address: a withdrawal pays out to one", () => {
    const m = fixtureManifest() as Mutable;
    m.actions.cancelOrder.calls[0].abi = "function withdraw(uint256 positionId, address to)";
    expect(() => parseManifest(m)).toThrow(/address input "to" is not accounted for/);
    m.actions.cancelOrder.calls[0].recipient = { arg: "to" };
    expect(() => parseManifest(m)).not.toThrow();
  });

  it("accepts an array of tuples carrying addresses once a reviewer has explained it, by the array's own name", () => {
    const m = fixtureManifest() as Mutable;
    m.actions.cancelOrder.calls[0].abi = "function sweep((address to, uint256 amount)[] moves, uint256 nonce)";
    m.actions.cancelOrder.calls[0].ignore = [{ arg: "moves", reason: "Refund legs, each paid to the order's own maker by the contract." }];
    expect(() => parseManifest(m)).not.toThrow();
  });

  it("accepts the fixture and returns typed data", () => {
    const m = parseManifest(fixtureManifest());
    expect(m.id).toBe("fixture");
    expect(m.contracts[String(FIXTURE_CHAIN_ID)]!.router!.address).toBe(ADDR.router);
    expect(Object.keys(m.actions)).toEqual(["swap", "swapNative", "cancelOrder"]);
  });

  const cases: Array<[string, (m: Mutable) => void, RegExp]> = [
    ["an id with uppercase", (m) => (m.id = "Fixture"), /id/],
    ["a non-checksummed contract address", (m) => (m.contracts[FIXTURE_CHAIN_ID].router.address = "0x52908400098527886e0f7030069857d2e4169ee7"), /checksum/i],
    ["a non-checksummed token address", (m) => (m.tokens[FIXTURE_CHAIN_ID][0].address = "0x52908400098527886e0f7030069857d2e4169ee7"), /checksum/i],
    ["contracts under a chain not in `chains`", (m) => (m.contracts["5"] = m.contracts[FIXTURE_CHAIN_ID]), /chain 5/],
    ["tokens under a chain not in `chains`", (m) => (m.tokens["5"] = m.tokens[FIXTURE_CHAIN_ID]), /chain 5/],
    ["a duplicate token address within a chain", (m) => m.tokens[FIXTURE_CHAIN_ID].push({ ...m.tokens[FIXTURE_CHAIN_ID][0], symbol: "USDC2" }), /duplicate token/i],
    ["a call naming an unknown contract key", (m) => (m.actions.swap.calls[0].contract = "vault"), /unknown contract "vault"/],
    ["an unparseable ABI string", (m) => (m.actions.swap.calls[0].abi = "function swap("), /abi/i],
    ["an ABI that is not a function", (m) => (m.actions.swap.calls[0].abi = "event Swap(address a)"), /function/i],
    ["an arg ref that is not an ABI input", (m) => (m.actions.swap.calls[0].recipient = { arg: "receiver" }), /"receiver"/],
    ["a dotted arg ref into a missing tuple component", (m) => (m.actions.swapNative.calls[0].recipient = { arg: "params.nope" }), /"params.nope"/],
    ["an amount ref to a non-uint input", (m) => (m.actions.swap.calls[0].spend[0].amount = { arg: "tokenIn" }), /uint/],
    ["a token ref to a non-address input", (m) => (m.actions.swap.calls[0].spend[0].token = { arg: "amountIn" }), /address/],
    ["msg.value on a non-payable function", (m) => (m.actions.swap.calls[0].spend = [{ token: "native", amount: "msg.value" }]), /payable/],
    ["spends:false with a spend entry", (m) => (m.actions.cancelOrder.calls[0].spend = [{ token: { const: ADDR.usdc }, amount: { const: "1" } }]), /spends/],
    ["spends:true with no spend anywhere", (m) => delete m.actions.swap.calls[0].spend, /spends/],
    ["more than 4 calls in one action", (m) => (m.actions.cancelOrder.calls = Array(5).fill(m.actions.cancelOrder.calls[0])), /4/],
    ["two calls in one protocol sharing a selector on the same contract", (m) => (m.actions.cancelAgain = structuredClone(m.actions.cancelOrder)), /selector/i],
    ["an unknown manifestVersion", (m) => (m.manifestVersion = 2), /manifestVersion/],
    // Security review C1/H1: every address a spending call takes must be accounted for.
    ["a spending call whose recipient is not declared", (m) => delete m.actions.swap.calls[0].recipient, /address input "to" is not accounted for/],
    ["a spending call with a second, unexplained address input", (m) => (m.actions.swap.calls[0].abi = "function swapExactIn(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address to, uint256 deadline, address refundTo)"), /address input "refundTo" is not accounted for/],
    ["an address hidden inside an ARRAY of tuples, which no argument path can pin", (m) => ((m.actions.cancelOrder.calls[0].abi = "function sweep((address to, uint256 amount)[] moves, uint256 nonce)")), /"moves" carries addresses/],
    ["an address array inside an array of tuples", (m) => ((m.actions.cancelOrder.calls[0].abi = "function batch((uint256 id, address[] payees)[] items)")), /"items" carries addresses/],
    ["an array of tuples nested inside a tuple", (m) => ((m.actions.cancelOrder.calls[0].abi = "function nested((uint256 id, (address to, uint256 amount)[] legs) order)")), /"order.legs" carries addresses/],
    ["a fixed-size array of tuples", (m) => ((m.actions.cancelOrder.calls[0].abi = "function pair((address to, uint256 amount)[2] moves)")), /"moves" carries addresses/],
    ["a plain address array", (m) => ((m.actions.cancelOrder.calls[0].abi = "function many(address[] payees)")), /address input "payees" is not accounted for/],
    ["an unexplained address inside a tuple", (m) => (m.actions.swapNative.calls[0].abi = "function swapNativeIn((address tokenOut, uint256 minOut, address to, address feeTo) params) payable"), /"params.feeTo" is not accounted for/],
    ["duplicate input names, which make an arg ref ambiguous", (m) => (m.actions.cancelOrder.calls[0].abi = "function cancel(uint256 orderId, uint256 orderId)"), /duplicate input name "orderId"/],
    ["an unnamed input", (m) => (m.actions.cancelOrder.calls[0].abi = "function cancel(uint256)"), /unnamed input/],
    ["an ignored address without a reason a reviewer can read", (m) => (m.actions.swap.calls[0].ignore = [{ arg: "to", reason: "ok" }]), /reason/],
    ["an ignore entry naming an input that does not exist", (m) => (m.actions.swap.calls[0].ignore = [{ arg: "nope", reason: "a documented reason for review" }]), /"nope"/],
    ["a const amount above uint256", (m) => (m.actions.swap.calls[0].spend[0].amount = { const: "1" + "0".repeat(90) }), /uint256/],
  ];

  it.each(cases)("rejects %s", (_name, mutate, message) => {
    let error: unknown;
    try {
      parseManifest(broken(mutate));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).code).toBe("INVALID_MANIFEST");
    expect((error as ProtocolError).message).toMatch(message);
  });
});
