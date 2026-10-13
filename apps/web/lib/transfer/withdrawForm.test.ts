import { decodeFunctionData, erc20Abi, getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { assetPaysGas, buildWithdrawRpc, validateAmount, validateWithdraw, type TransferAsset } from "./withdrawForm";

const FROM = "0x0000000000000000000000000000000000001001";
const TO = "0x0000000000000000000000000000000000001002";
const USDC: TransferAsset = { chainId: 5042002, token: "0x0000000000000000000000000000000000000201", symbol: "USDC", name: "USD Coin", decimals: 6, held: 100_000_000n, trust: "canonical" };
const ETH: TransferAsset = { chainId: 11155931, token: "native", symbol: "ETH", name: "Ether", decimals: 18, held: 10n ** 18n, trust: "canonical" };

/** A valid checksummed address with the case of one letter flipped, which breaks EIP-55. */
const BAD_CHECKSUM = getAddress("0xabcdef0000000000000000000000000000001003").replace(/[a-fA-F]/, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));

const ok = { asset: USDC, amount: "25", recipient: TO, from: FROM, max: 99_000_000n };

describe("validateWithdraw", () => {
  it("accepts a well-formed withdrawal and returns exact base units", () => {
    expect(validateWithdraw(ok)).toEqual({ ok: true, amount: 25_000_000n, recipient: TO });
  });

  it("checksums a lowercase recipient rather than refusing it", () => {
    const lower = "0xabcdef0000000000000000000000000000001002";
    const result = validateWithdraw({ ...ok, recipient: lower });
    expect(result.ok && result.recipient).toBe(getAddress(lower));
    expect(getAddress(lower)).not.toBe(lower);
  });

  it.each([
    ["no asset", { asset: null }, "asset"],
    ["an empty amount", { amount: "" }, "amount"],
    ["zero", { amount: "0.000" }, "amount"],
    ["more decimals than the token has", { amount: "1.0000001" }, "amount"],
    ["a non-number", { amount: "1e3" }, "amount"],
    ["more than is held", { amount: "100.000001" }, "amount"],
    ["more than the gas-adjusted maximum", { amount: "99.5" }, "amount"],
    ["an empty recipient", { recipient: "" }, "recipient"],
    ["a shortened address pasted from a UI", { recipient: "0x38A1…7f0A" }, "recipient"],
    ["a 39-hex address", { recipient: TO.slice(0, -1) }, "recipient"],
    ["a mixed-case address with a bad checksum", { recipient: BAD_CHECKSUM }, "recipient"],
    ["the sending wallet itself", { recipient: FROM }, "recipient"],
    ["the token contract as the recipient", { recipient: USDC.token }, "recipient"],
    ["the zero address", { recipient: "0x0000000000000000000000000000000000000000" }, "recipient"],
    ["no connected wallet", { from: undefined }, "account"],
  ])("refuses %s", (_name, patch, field) => {
    const result = validateWithdraw({ ...ok, ...patch } as Parameters<typeof validateWithdraw>[0]);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.field).toBe(field);
    expect(!result.ok && result.message.length).toBeGreaterThan(10);
  });

  it("says when the maximum is lower than the balance because gas is paid in the same asset", () => {
    const result = validateWithdraw({ ...ok, amount: "99.5" });
    expect(!result.ok && result.message).toMatch(/network fee/i);
  });
});

describe("validateWithdraw — review findings", () => {
  it("refuses any amount while the network fee is unknown for an asset that pays its own gas", () => {
    // Without a gas price no fee can be reserved, so "Max" would be the whole balance
    // and the transfer would then fail for want of gas.
    const result = validateWithdraw({ ...ok, feeKnown: false });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.field).toBe("amount");
    expect(!result.ok && result.message).toMatch(/network fee/i);
  });

  it("accepts an all-uppercase address, which carries no checksum, and checksums it", () => {
    const upper = `0x${"ABCDEF0000000000000000000000000000001002"}`;
    const result = validateWithdraw({ ...ok, recipient: upper });
    expect(result.ok && result.recipient).toBe(getAddress(upper.toLowerCase()));
  });
});

describe("validateAmount", () => {
  it("parses a plain decimal into exact base units and a canonical string", () => {
    expect(validateAmount("25.50", USDC)).toEqual({ ok: true, amount: 25_500_000n, text: "25.5" });
    expect(validateAmount(".5", USDC)).toEqual({ ok: true, amount: 500_000n, text: "0.5" });
  });

  it.each([["empty", ""], ["zero", "0"], ["a lone dot", "."], ["a sign", "+5"], ["an exponent", "1e3"], ["inner whitespace", "1 000"], ["full-width digits", String.fromCodePoint(0xff11, 0xff10)], ["too many decimals", "1.0000001"]])("refuses %s", (_n, text) => {
    expect(validateAmount(text, USDC).ok).toBe(false);
  });
});

describe("buildWithdrawRpc", () => {
  it("builds an ERC-20 transfer with the exact amount and no native value", () => {
    const rpc = buildWithdrawRpc({ asset: USDC, amount: 25_000_000n, recipient: TO, from: FROM });
    expect(rpc.method).toBe("eth_sendTransaction");
    const [tx] = rpc.params as [{ from: string; to: string; data: `0x${string}`; value: string }];
    expect(tx.from).toBe(FROM);
    expect(tx.to).toBe(USDC.token);
    expect(tx.value).toBe("0x0");
    const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data });
    expect(decoded.functionName).toBe("transfer");
    expect(decoded.args).toEqual([TO, 25_000_000n]);
  });

  it("builds a native transfer with the amount as hex value and empty data", () => {
    const rpc = buildWithdrawRpc({ asset: ETH, amount: 10n ** 17n, recipient: TO, from: FROM });
    const [tx] = rpc.params as [{ to: string; data?: string; value: string }];
    expect(tx.to).toBe(TO);
    expect(tx.value).toBe("0x16345785d8a0000");
    expect(tx.data).toBeUndefined();
  });
});

describe("assetPaysGas", () => {
  it("is true for the chain's gas asset and for a reviewed token that is the same funds", () => {
    expect(assetPaysGas(ETH, "ETH")).toBe(true);
    expect(assetPaysGas(USDC, "USDC")).toBe(true);
  });

  it("is never true for an unreviewed token, whatever symbol it gives itself", () => {
    // Anyone can deploy a token that calls itself USDC. Its symbol must not earn it a gas reserve.
    const lookalike: TransferAsset = { ...USDC, token: "0x1111111111111111111111111111111111111111", trust: "unreviewed" };
    expect(assetPaysGas(lookalike, "USDC")).toBe(false);
  });
});
