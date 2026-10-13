import { encodeFunctionData, erc20Abi, maxUint256, parseAbi, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import type { TxRequest } from "../types";
import { ADDR, FIXTURE_CHAIN_ID, fixtureManifest } from "../testing/fixture";
import { decodeAction, decodeApproval } from "./decode";
import { parseManifest } from "./schema";

const manifest = parseManifest(fixtureManifest());
const routerAbi = parseAbi([
  "function swapExactIn(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address to, uint256 deadline)",
  "function swapNativeIn((address tokenOut, uint256 minOut, address to) params) payable",
  "function sweep(address to)",
]);
const bookAbi = parseAbi(["function cancel(uint256 orderId)"]);

function tx(to: string, data: Hex, value = 0n): TxRequest {
  return { chainId: FIXTURE_CHAIN_ID, to: to as TxRequest["to"], data, value };
}

function swapData(overrides: Partial<{ tokenIn: string; to: string; amountIn: bigint }> = {}): Hex {
  return encodeFunctionData({
    abi: routerAbi,
    functionName: "swapExactIn",
    args: [(overrides.tokenIn ?? ADDR.usdc) as `0x${string}`, ADDR.weth, overrides.amountIn ?? 50_000_000n, 24_780_000_000_000_000n, (overrides.to ?? ADDR.alice) as `0x${string}`, 1_900_000_000n],
  });
}

describe("decodeAction", () => {
  it("decodes a token swap from calldata alone", () => {
    expect(decodeAction(manifest, tx(ADDR.router, swapData()), ADDR.alice)).toEqual({
      protocol: "fixture",
      action: "swap",
      chainId: FIXTURE_CHAIN_ID,
      contract: "router",
      spends: true,
      spend: [{ token: ADDR.usdc, amount: 50_000_000n, listed: true }],
      receive: { token: ADDR.weth, minAmount: 24_780_000_000_000_000n, listed: true },
      unlisted: false,
      recipient: ADDR.alice,
      deadline: 1_900_000_000n,
    });
  });

  it("decodes a native spend from msg.value and dotted tuple args", () => {
    const data = encodeFunctionData({ abi: routerAbi, functionName: "swapNativeIn", args: [{ tokenOut: ADDR.usdc, minOut: 49_000_000n, to: ADDR.alice }] });
    expect(decodeAction(manifest, tx(ADDR.router, data, 10n ** 16n), ADDR.alice)).toMatchObject({
      action: "swapNative",
      spend: [{ token: "native", amount: 10n ** 16n, listed: true }],
      receive: { token: ADDR.usdc, minAmount: 49_000_000n, listed: true },
      recipient: ADDR.alice,
    });
  });

  it("decodes an action that spends nothing", () => {
    const data = encodeFunctionData({ abi: bookAbi, functionName: "cancel", args: [7n] });
    expect(decodeAction(manifest, tx(ADDR.book, data), ADDR.alice)).toMatchObject({ action: "cancelOrder", spends: false, spend: [] });
  });

  it("matches the contract address case-insensitively", () => {
    const upper = `0x${ADDR.router.slice(2).toUpperCase()}`;
    expect(decodeAction(manifest, tx(upper, swapData()), ADDR.alice)?.action).toBe("swap");
  });

  const refusals: Array<[string, TxRequest, string]> = [
    ["a contract the manifest does not list", tx(ADDR.stranger, swapData()), ADDR.alice],
    ["a known contract with an unknown selector", tx(ADDR.router, encodeFunctionData({ abi: routerAbi, functionName: "sweep", args: [ADDR.mallory] })), ADDR.alice],
    ["a selector that belongs to a different contract", tx(ADDR.router, encodeFunctionData({ abi: bookAbi, functionName: "cancel", args: [7n] })), ADDR.alice],
    ["truncated calldata", tx(ADDR.router, swapData().slice(0, 80) as Hex), ADDR.alice],
    ["empty calldata", tx(ADDR.router, "0x"), ADDR.alice],
    ["a recipient that is not the signer", tx(ADDR.router, swapData({ to: ADDR.mallory })), ADDR.alice],
    ["native value attached to a call that declares no native spend", tx(ADDR.router, swapData(), 1n), ADDR.alice],
    ["a chain the manifest does not serve", { ...tx(ADDR.router, swapData()), chainId: 1 }, ADDR.alice],
  ];

  it.each(refusals)("returns null for %s", (_name, request, signer) => {
    expect(decodeAction(manifest, request, signer as `0x${string}`)).toBeNull();
  });

  // Security review C2: a declared native spend must equal the value actually attached.
  it("returns null when the native amount a call declares differs from tx.value", () => {
    const m = fixtureManifest() as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    m.actions.swapNative.calls[0].spend = [{ token: "native", amount: { arg: "params.minOut" } }];
    const lying = parseManifest(m);
    const data = encodeFunctionData({ abi: routerAbi, functionName: "swapNativeIn", args: [{ tokenOut: ADDR.usdc, minOut: 1n, to: ADDR.alice }] });
    expect(decodeAction(lying, tx(ADDR.router, data, 10n ** 19n), ADDR.alice)).toBeNull();
    expect(decodeAction(lying, tx(ADDR.router, data, 1n), ADDR.alice)?.spend).toEqual([{ token: "native", amount: 1n, listed: true }]);
  });

  // Unlisted tokens (a freshly launched coin) are described but flagged, so nothing makes or matches a rule for them.
  it("flags a receive token the manifest does not list instead of vouching for it", () => {
    const data = encodeFunctionData({ abi: routerAbi, functionName: "swapExactIn", args: [ADDR.usdc, ADDR.stranger, 1n, 1n, ADDR.alice, 1n] });
    expect(decodeAction(manifest, tx(ADDR.router, data), ADDR.alice)).toMatchObject({ unlisted: true, receive: { token: ADDR.stranger, listed: false }, spend: [{ listed: true }] });
  });

  it("flags a spend token the manifest does not list", () => {
    expect(decodeAction(manifest, tx(ADDR.router, swapData({ tokenIn: ADDR.stranger })), ADDR.alice)).toMatchObject({ unlisted: true, spend: [{ token: ADDR.stranger, listed: false }] });
  });

  // Security review L1: one meaning per calldata. viem tolerates both of these; the EVM's ABI decoder does not.
  it("returns null for calldata with bytes appended after the arguments", () => {
    expect(decodeAction(manifest, tx(ADDR.router, `${swapData()}deadbeef` as Hex), ADDR.alice)).toBeNull();
  });

  it("returns null for an address word with dirty upper bits", () => {
    const clean = swapData();
    // The `to` argument is the fifth word: 10 chars of selector + 4 words, then 24 hex chars of padding.
    const at = 10 + 64 * 4;
    const dirty = `${clean.slice(0, at)}${"f".repeat(24)}${clean.slice(at + 24)}` as Hex;
    expect(dirty).not.toBe(clean);
    expect(decodeAction(manifest, tx(ADDR.router, dirty), ADDR.alice)).toBeNull();
  });

  it("never throws on hostile input", () => {
    expect(() => decodeAction(manifest, tx(ADDR.router, "0xzz" as Hex), ADDR.alice)).not.toThrow();
    expect(decodeAction(manifest, tx(ADDR.router, "0xzz" as Hex), ADDR.alice)).toBeNull();
  });
});

describe("decodeApproval", () => {
  const approve = (spender: string, amount: bigint) => encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender as `0x${string}`, amount] });

  it("reports an exact approval of a listed token to a router", () => {
    expect(decodeApproval(manifest, tx(ADDR.usdc, approve(ADDR.router, 50_000_000n)))).toEqual({
      protocol: "fixture",
      chainId: FIXTURE_CHAIN_ID,
      token: ADDR.usdc,
      spender: ADDR.router,
      spenderKey: "router",
      amount: 50_000_000n,
      unlimited: false,
    });
  });

  it("returns null for an approval with bytes appended after the arguments", () => {
    expect(decodeApproval(manifest, tx(ADDR.usdc, `${approve(ADDR.router, 1n)}00` as Hex))).toBeNull();
  });

  it("flags an unlimited approval so callers can refuse it", () => {
    expect(decodeApproval(manifest, tx(ADDR.usdc, approve(ADDR.router, maxUint256)))?.unlimited).toBe(true);
  });

  it.each([
    ["a spender that is not a router-role contract", tx(ADDR.usdc, approve(ADDR.book, 1n))],
    ["a spender outside the manifest", tx(ADDR.usdc, approve(ADDR.mallory, 1n))],
    ["a token outside the manifest", tx(ADDR.stranger, approve(ADDR.router, 1n))],
    ["a transfer, which is not an approval", tx(ADDR.usdc, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [ADDR.router, 1n] }))],
    ["an approval carrying native value", tx(ADDR.usdc, approve(ADDR.router, 1n), 1n)],
  ])("returns null for %s", (_name, request) => {
    expect(decodeApproval(manifest, request)).toBeNull();
  });
});
