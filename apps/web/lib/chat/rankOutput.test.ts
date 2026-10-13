import { describe, expect, it } from "vitest";
import { parseRankOutput } from "./rankOutput";

const row = { rank: 1, id: "0x01", symbol: "DOUGH/USDC", base: { address: "0x02", symbol: "DOUGH" }, quote: { address: "0x03", symbol: "USDC" }, tvlUSD: 120_000, volume24hUSD: 310_000, feeBps: 30, estLpFeeAprPct: 282.9, change7dPct: -6, change30dPct: -38 };
const result = { measure: "highest_yield", basis: "Estimated LP fee APR.", minTvlUSD: 10_000, considered: 9, eligible: 8, none: false, rows: [row] };

describe("parseRankOutput", () => {
  it("accepts a rank result, with null fee and APR", () => {
    expect(parseRankOutput(result)?.rows[0]?.symbol).toBe("DOUGH/USDC");
    expect(parseRankOutput({ ...result, rows: [{ ...row, feeBps: null, estLpFeeAprPct: null }] })?.rows[0]?.estLpFeeAprPct).toBeNull();
  });
  it("accepts an unknown price change, which the read sends as null and is not the same as no change", () => {
    const parsed = parseRankOutput({ ...result, rows: [{ ...row, change7dPct: null, change30dPct: null }] });
    expect(parsed?.rows[0]).toMatchObject({ change7dPct: null, change30dPct: null });
  });
  it("carries how many markets were looked at, and still accepts a result saved before it was there", () => {
    expect(parseRankOutput(result)?.considered).toBe(9);
    const older = { ...result } as Record<string, unknown>;
    delete older.considered;
    expect(parseRankOutput(older)?.rows).toHaveLength(1);
  });
  it("accepts 'nothing qualifies' with its note", () => expect(parseRankOutput({ ...result, none: true, note: "No listed market…", rows: [] })).toMatchObject({ none: true, note: "No listed market…" }));
  it.each([["a read failure", { error: { code: "X", message: "m" } }], ["null", null], ["a string", "rows"], ["rows of the wrong shape", { ...result, rows: [{ symbol: 1 }] }], ["more rows than a rank returns", { ...result, rows: Array.from({ length: 11 }, () => row) }]])("is null for %s, so the generic read card is shown instead", (_n, value) => expect(parseRankOutput(value)).toBeNull());
});
