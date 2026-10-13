import { z } from "zod";

/** What the rank table renders. Parsed, not trusted: a saved chat may hold an older or a failed result. */
const token = z.object({ address: z.string(), symbol: z.string().max(64) });
const rankView = z.object({
  measure: z.string().max(40),
  basis: z.string().max(300),
  minTvlUSD: z.number(),
  // How many markets the read looked at. Optional: a result saved before the table showed it still parses.
  considered: z.number().optional(),
  none: z.boolean(),
  note: z.string().max(300).optional(),
  rows: z.array(z.object({ rank: z.number().int(), id: z.string(), symbol: z.string().max(64), base: token, quote: token, tvlUSD: z.number(), volume24hUSD: z.number(), feeBps: z.number().nullable(), estLpFeeAprPct: z.number().nullable(), change7dPct: z.number().nullable(), change30dPct: z.number().nullable() })).max(10),
});
export type RankView = z.infer<typeof rankView>;

export function parseRankOutput(output: unknown): RankView | null {
  const parsed = rankView.safeParse(output);
  return parsed.success ? parsed.data : null;
}
