import { describe, expect, it } from "vitest";
import { RANK_MEASURES } from "../types";
import { MIN_RANK_TVL_USD, rankMarkets, type RankMarket } from "./rank";

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const USDC = { address: A(1), symbol: "USDC" };
const m = (n: number, symbol: string, tvlUSD: number, volume24hUSD: number, takerFee: number | null, change7dPct: number | null, change30dPct: number | null, listed = true): RankMarket => ({ id: A(100 + n), symbol: `${symbol}/USDC`, listed, base: { address: A(200 + n), symbol }, quote: USDC, tvlUSD, volume24hUSD, takerFee, change7dPct, change30dPct });

// The spike's fixture (docs/research/2026-09-20-jev-spike/harness/fixture.json).
const MARKETS = [
  m(1, "WETH", 4_200_000, 1_900_000, 0.0005, 3.1, 6),
  m(2, "WBTC", 6_800_000, 1_200_000, 0.0005, 1.2, 2.5),
  m(3, "USDT", 9_500_000, 900_000, 0.0001, 0, 0.01),
  m(4, "SKHY", 2_100_000, 2_400_000, 0.001, -1, -7.95),
  m(5, "RATE", 850_000, 640_000, 0.003, 18.4, 41),
  m(6, "DOUGH", 120_000, 310_000, 0.003, -6, -38),
  m(7, "YEAST", 95_000, 40_000, 0.003, 44, 12),
  m(8, "PHNX", 40_000, 5_000, 0.003, 2, -52),
  m(9, "PICKME", 900, 0, 0.003, 0, 0, false),
];

describe("rankMarkets", () => {
  it.each([
    ["highest_yield", "DOUGH/USDC"],
    ["deepest_liquidity", "USDT/USDC"],
    ["most_traded", "SKHY/USDC"],
    ["weekly_momentum", "YEAST/USDC"],
    ["monthly_dip", "PHNX/USDC"],
    ["lowest_risk", "USDT/USDC"],
  ] as const)("%s is led by %s", (measure, winner) => {
    const result = rankMarkets(MARKETS, measure);
    expect(result.none).toBe(false);
    expect(result.rows[0]).toMatchObject({ rank: 1, symbol: winner });
    expect(result.rows.map((r) => r.rank)).toEqual(result.rows.map((_, i) => i + 1));
    expect(result.basis.length).toBeGreaterThan(10);
  });

  it("estimates LP fee APR as volume x fee x 365 / TVL, in percent to one decimal, and reports the fee in basis points", () => {
    const [top] = rankMarkets(MARKETS, "highest_yield").rows;
    expect(top).toMatchObject({ symbol: "DOUGH/USDC", feeBps: 30, estLpFeeAprPct: 282.9 });
  });

  it("never ranks an unlisted market, whatever measure is asked and however it scores", () => {
    const loud = [...MARKETS, { ...m(10, "LOUD", 50_000_000, 90_000_000, 0.01, 900, -99), listed: false }];
    for (const measure of RANK_MEASURES) expect(rankMarkets(loud, measure, 10).rows.map((r) => r.symbol)).not.toContain("LOUD/USDC");
  });

  it("drops markets under the liquidity floor, and counts what it considered and what was eligible", () => {
    const result = rankMarkets(MARKETS, "deepest_liquidity", 10);
    expect(result.minTvlUSD).toBe(MIN_RANK_TVL_USD);
    expect(result.considered).toBe(9);
    expect(result.eligible).toBe(8);
    expect(result.rows.every((r) => r.tvlUSD >= MIN_RANK_TVL_USD)).toBe(true);
  });

  it("says nothing qualifies on an empty testnet: zero volume, tiny TVL, no fee", () => {
    const empty = [m(1, "SKHY", 317, 0, null, 0, -7.95), m(2, "YEAST", 819, 0, null, 0, -2.74)];
    for (const measure of RANK_MEASURES) {
      const result = rankMarkets(empty, measure);
      expect(result).toMatchObject({ none: true, rows: [], eligible: 0 });
      expect(result.note).toMatch(/\$10,000/);
    }
  });

  it("an unknown fee means an unknown APR, never zero: such a market cannot lead on yield but still ranks on depth", () => {
    const markets = [m(1, "AAA", 500_000, 100_000, null, 1, 1), m(2, "BBB", 400_000, 50_000, 0.003, 1, 1)];
    expect(rankMarkets(markets, "highest_yield").rows.map((r) => r.symbol)).toEqual(["BBB/USDC"]);
    expect(rankMarkets(markets, "deepest_liquidity").rows[0]).toMatchObject({ symbol: "AAA/USDC", feeBps: null, estLpFeeAprPct: null });
  });

  it("an unknown price change is unknown, never a market that did not move: it cannot lead the measures made of price, but still ranks on depth", () => {
    // Well above the liquidity floor, and deep enough to lead `lowest_risk` outright if an unknown change were read as zero.
    const markets = [m(1, "QUIET", 5_000_000, 100_000, 0.003, null, null), m(2, "KNOWN", 400_000, 50_000, 0.003, 4, -9)];
    for (const measure of ["lowest_risk", "monthly_dip", "weekly_momentum"] as const) expect(rankMarkets(markets, measure, 10).rows.map((r) => r.symbol)).toEqual(["KNOWN/USDC"]);
    // The same market is still ranked where the unknown does not matter, and says the change is unknown rather than 0%.
    expect(rankMarkets(markets, "deepest_liquidity", 10).rows[0]).toMatchObject({ symbol: "QUIET/USDC", change7dPct: null, change30dPct: null });
  });

  it("breaks ties by TVL, then by symbol, so the order is stable", () => {
    const tied = [m(1, "BBB", 200_000, 50_000, 0.003, 5, 0), m(2, "AAA", 200_000, 50_000, 0.003, 5, 0), m(3, "CCC", 300_000, 50_000, 0.003, 5, 0)];
    expect(rankMarkets(tied, "weekly_momentum").rows.map((r) => r.symbol)).toEqual(["CCC/USDC", "AAA/USDC", "BBB/USDC"]);
  });

  it("returns at most `limit` rows, five by default", () => {
    expect(rankMarkets(MARKETS, "deepest_liquidity").rows).toHaveLength(5);
    expect(rankMarkets(MARKETS, "deepest_liquidity", 2).rows).toHaveLength(2);
  });
});
