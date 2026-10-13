import { describe, expect, it } from "vitest";
import { arrangeTokens } from "./arrange";

const row = (token: string, symbol: string, decimals: number, held: bigint) => ({ token: token as `0x${string}` | "native", symbol, decimals, held });
const USDC = row("0x3600000000000000000000000000000000000000", "USDC", 6, 5_000_000n); // 5
const DUST = row("0x2222222222222222222222222222222222222222", "DUST", 18, 10n ** 15n); // 0.001
const ZED = row("0x4444444444444444444444444444444444444444", "ZED", 6, 0n);
const ABC = row("0x5555555555555555555555555555555555555555", "ABC", 6, 0n);

describe("arrangeTokens", () => {
  it("orders by value across decimals, then by symbol", () => {
    // Raw base units would put 10^15 of an 18-decimal token above 5 USDC.
    const { shown } = arrangeTokens([DUST, ZED, USDC, ABC], { pinned: [], hidden: [] });
    expect(shown.map((t) => t.symbol)).toEqual(["USDC", "DUST", "ABC", "ZED"]);
  });

  it("puts pinned tokens first", () => {
    const { shown } = arrangeTokens([USDC, DUST, ZED], { pinned: [ZED.token], hidden: [] });
    expect(shown.map((t) => t.symbol)).toEqual(["ZED", "USDC", "DUST"]);
  });

  it("moves hidden tokens out of the list", () => {
    const { shown, hidden } = arrangeTokens([USDC, DUST], { pinned: [], hidden: [USDC.token.toLowerCase()] });
    expect(shown.map((t) => t.symbol)).toEqual(["DUST"]);
    expect(hidden.map((t) => t.symbol)).toEqual(["USDC"]);
  });

  it("matches ids in any case", () => {
    const upper = row("0xABCDEF0123456789ABCDEF0123456789ABCDEF01", "UP", 6, 0n);
    const { hidden } = arrangeTokens([upper], { pinned: [], hidden: ["0xabcdef0123456789abcdef0123456789abcdef01"] });
    expect(hidden).toHaveLength(1);
  });
});
