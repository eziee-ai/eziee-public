import { describe, expect, it } from "vitest";
import type { Token } from "@repo/protocols/types";
import { sharesListedSymbol, toTransferAssets, unreadableExtras } from "./assets";

const ARC = 5042002;
const USDC: Token = { chainId: ARC, address: "0x3600000000000000000000000000000000000000", symbol: "USDC", name: "USD Coin", decimals: 6, trust: "canonical" };
const EURC: Token = { chainId: ARC, address: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a", symbol: "EURC", name: "Euro Coin", decimals: 6, trust: "listed" };
const EXTRA = { address: "0x1111111111111111111111111111111111111111", symbol: "TEST", name: "Test Token", decimals: 6 } as const;

describe("toTransferAssets", () => {
  const rows = [
    { token: "native" as const, symbol: "ETH", decimals: 18, amount: "7" },
    { token: USDC.address, symbol: "USDC", decimals: 6, amount: "100" },
    { token: EURC.address.toLowerCase() as `0x${string}`, symbol: "EURC", decimals: 6, amount: "0" },
  ];

  it("labels the native asset canonical and registry tokens with their own trust", () => {
    const assets = toTransferAssets({ chainId: ARC, rows, registry: [USDC, EURC], nativeName: "Ether", extras: [], extraHeld: new Map() });
    expect(assets.map((a) => [a.symbol, a.trust, a.name])).toEqual([
      ["ETH", "canonical", "Ether"],
      ["USDC", "canonical", "USD Coin"],
      ["EURC", "listed", "Euro Coin"],
    ]);
  });

  it("adds custom tokens as unreviewed, with the balance read for them", () => {
    const assets = toTransferAssets({ chainId: ARC, rows, registry: [USDC, EURC], nativeName: "Ether", extras: [EXTRA], extraHeld: new Map([[EXTRA.address.toLowerCase(), 5_000_000n]]) });
    expect(assets.at(-1)).toEqual({ chainId: ARC, token: EXTRA.address, symbol: "TEST", name: "Test Token", decimals: 6, held: 5_000_000n, trust: "unreviewed" });
  });

  it("never lists a custom token twice when it is also on the registry", () => {
    const shadow = { ...EXTRA, address: USDC.address.toLowerCase() as `0x${string}`, symbol: "FAKE" };
    const assets = toTransferAssets({ chainId: ARC, rows, registry: [USDC, EURC], nativeName: "Ether", extras: [shadow], extraHeld: new Map([[USDC.address.toLowerCase(), 1n]]) });
    expect(assets.filter((a) => a.token.toLowerCase() === USDC.address.toLowerCase())).toHaveLength(1);
    expect(assets.some((a) => a.symbol === "FAKE")).toBe(false);
  });

  it("leaves a custom token out until its balance is read", () => {
    const assets = toTransferAssets({ chainId: ARC, rows, registry: [USDC], nativeName: "Ether", extras: [EXTRA], extraHeld: undefined });
    expect(assets.some((a) => a.symbol === "TEST")).toBe(false);
  });

  it("leaves out a token whose balance read failed, never showing it as zero", () => {
    const BROKEN = { ...EXTRA, address: "0x3333333333333333333333333333333333333333", symbol: "BRKN" } as const;
    const held = new Map<string, bigint | null>([
      [EXTRA.address.toLowerCase(), 5_000_000n],
      [BROKEN.address.toLowerCase(), null],
    ]);
    const assets = toTransferAssets({ chainId: ARC, rows, registry: [USDC], nativeName: "Ether", extras: [EXTRA, BROKEN], extraHeld: held });
    expect(assets.some((a) => a.symbol === "TEST")).toBe(true);
    expect(assets.some((a) => a.symbol === "BRKN")).toBe(false);
    expect(unreadableExtras([EXTRA, BROKEN], [USDC], held)).toEqual([BROKEN]);
  });

  it("reports nothing unreadable before the balances are read", () => {
    expect(unreadableExtras([EXTRA], [USDC], undefined)).toEqual([]);
  });
});

describe("sharesListedSymbol", () => {
  const asset = (symbol: string, trust: "unreviewed" | "canonical") => ({ chainId: ARC, token: EXTRA.address, symbol, name: "x", decimals: 6, held: 0n, trust });

  it("flags an unreviewed token that calls itself by a reviewed token's symbol, in any case", () => {
    expect(sharesListedSymbol(asset("usdc", "unreviewed"), [USDC, EURC])).toBe(true);
  });

  it("does not flag an unreviewed token with its own symbol, or a reviewed token", () => {
    expect(sharesListedSymbol(asset("TEST", "unreviewed"), [USDC, EURC])).toBe(false);
    const listed = { ...asset("USDC", "canonical"), token: USDC.address };
    expect(sharesListedSymbol(listed, [USDC, EURC])).toBe(false);
  });

  it("only compares with tokens listed on the asset's own chain", () => {
    expect(sharesListedSymbol(asset("USDC", "unreviewed"), [{ ...USDC, chainId: 1 }])).toBe(false);
  });
});
