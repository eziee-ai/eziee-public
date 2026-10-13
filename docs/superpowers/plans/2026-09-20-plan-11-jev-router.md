# Plan 11 — Jev Router and the Rank Read Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a person asks to buy or provide liquidity by a stated measure, the ranked table is on screen in about half a second and the model explains it in one turn instead of two.

**Architecture:** A deterministic `rank` read orders a protocol's markets by a named measure. A small router asks TypeSafe's Jev two typed questions about the latest user message (intent, measure). When both answers clear a confidence gate, the server runs `rank` itself and streams the call and its result ahead of the agent as an ordinary tool part; the model receives it as a call it already made. Anything short of that leaves today's path untouched.

**Tech Stack:** TypeScript, zod 3, `ai@7` (`createUIMessageStream`, `createAgentUIStream`), vitest, Next.js 16, TypeSafe HTTP API (`POST https://api.typesafe.ai/v1/systemone`, no SDK).

**Spec:** `docs/superpowers/specs/2026-09-20-jev-router-design.md` (R1–R7). Evidence: `docs/research/2026-09-20-jev-spike/`.

## Global Constraints
- Branch `feat/plan-11-jev-router` from `fix/plans-7-9-review`, in the worktree `AI-finance-agent-worktree-4`. Never edit the main checkout. Commit by explicit path; never `git add -A`.
- Jev reads the latest user message and nothing else: no address, no history, no balances, no market data.
- Jev never chooses a market and never touches a transaction. Its output selects one value of `RANK_MEASURES` for a read-only tool.
- Off is the default and every failure is off: no key, timeout (1,500 ms), non-200, redirect, oversize or malformed body, confidence under `ROUTER_GATE` (0.9), a non-buy/LP intent, measure `unspecified`, a continuation request, no adapter with `reads.rank`, or a `rank` failure. None is shown to the person as an error.
- Nothing outside is called before credit is held.
- Gateway and Jev text is data: cleaned with `clean`, capped, schema-checked. An unlisted market never appears in a rank.
- An APR is always called "estimated". The desk does not advise: no measure stated, no pre-run.
- Test first. Each task ends with its package's `pnpm test`, `pnpm typecheck` and `pnpm lint` clean.
- No new dependency.

## File map
| File | Responsibility |
|---|---|
| `packages/protocols/src/types.ts` (modify) | `RANK_MEASURES`, `RankMeasure` |
| `packages/protocols/src/iter/rank.ts` (create) | pure `rankMarkets`, `MIN_RANK_TVL_USD`, `RankMarket`, `RankResult` |
| `packages/protocols/src/iter/rank.test.ts` (create) | winners per measure, hostile listing, empty snapshot, ties, limit |
| `packages/protocols/src/iter/reads.ts` (modify) | the `rank` read: gateway call, tolerant schema, mapping |
| `packages/protocols/src/iter/reads.test.ts` (modify) | the read over a fake gateway; the adapter's read list |
| `packages/agent/src/router.ts` (create) | `readRequest`, `decidePrerun`, `ROUTER_GATE`, `Reading` |
| `packages/agent/src/router.test.ts` (create) | request shape, every failure, the gate |
| `packages/agent/src/prompt.ts`, `index.ts` (modify) | two prompt sentences; exports |
| `apps/web/lib/server/prerun.ts` (create) | `planPrerun`: from messages + adapters + a reader to a ready tool part |
| `apps/web/lib/server/prerun.test.ts` (create) | when it fires, when it does not |
| `apps/web/lib/server/chat.ts` (modify) | call `planPrerun` after the hold; compose the stream |
| `apps/web/lib/server/chat.test.ts` (modify) | one model call, one saved message, settlement, fall-backs |
| `apps/web/components/chat/rankOutput.ts` + `.test.ts` (create) | `parseRankOutput`, a zod guard for what the table renders |
| `apps/web/components/chat/RankTable.tsx` (create) | the table |
| `apps/web/components/chat/ToolParts.tsx` (modify, ~4 lines) | render it for `*_rank` |
| `apps/web/.env.example`, `README.md` (modify) | `TYPESAFE_API_KEY` |

---

### Task 1: the measure list and the pure ranker

**Files:** Modify `packages/protocols/src/types.ts`. Create `packages/protocols/src/iter/rank.ts`, `packages/protocols/src/iter/rank.test.ts`.

**Interfaces — Produces:**
```ts
// types.ts
export const RANK_MEASURES = ["highest_yield", "deepest_liquidity", "most_traded", "weekly_momentum", "monthly_dip", "lowest_risk"] as const;
export type RankMeasure = (typeof RANK_MEASURES)[number];

// iter/rank.ts
export const MIN_RANK_TVL_USD = 10_000;
export interface RankMarket { id: string; symbol: string; listed: boolean; base: { address: string; symbol: string }; quote: { address: string; symbol: string }; tvlUSD: number; volume24hUSD: number; takerFee: number | null; change7dPct: number; change30dPct: number }
export interface RankRow { rank: number; id: string; symbol: string; base: { address: string; symbol: string }; quote: { address: string; symbol: string }; tvlUSD: number; volume24hUSD: number; feeBps: number | null; estLpFeeAprPct: number | null; change7dPct: number; change30dPct: number }
export interface RankResult { measure: RankMeasure; basis: string; minTvlUSD: number; considered: number; eligible: number; none: boolean; note?: string; rows: RankRow[] }
export function rankMarkets(markets: readonly RankMarket[], measure: RankMeasure, limit?: number): RankResult;
```

- [x] **Step 1: write the failing test** — `packages/protocols/src/iter/rank.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { RANK_MEASURES } from "../types";
import { MIN_RANK_TVL_USD, rankMarkets, type RankMarket } from "./rank";

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const USDC = { address: A(1), symbol: "USDC" };
const m = (n: number, symbol: string, tvlUSD: number, volume24hUSD: number, takerFee: number | null, change7dPct: number, change30dPct: number, listed = true): RankMarket => ({ id: A(100 + n), symbol: `${symbol}/USDC`, listed, base: { address: A(200 + n), symbol }, quote: USDC, tvlUSD, volume24hUSD, takerFee, change7dPct, change30dPct });

// The spike's fixture (docs/research/2026-09-20-jev-spike/harness/fixture.json).
const MARKETS = [
  m(1, "WETH", 4_200_000, 1_900_000, 0.0005, 3.1, 6),
  m(2, "WBTC", 6_800_000, 1_200_000, 0.0005, 1.2, 2.5),
  m(3, "USDT", 9_500_000, 900_000, 0.0001, 0, 0.01),
  m(4, "SKHY", 2_100_000, 2_400_000, 0.001, -1, -7.95),
  m(5, "ITER", 850_000, 640_000, 0.003, 18.4, 41),
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

  it("breaks ties by TVL, then by symbol, so the order is stable", () => {
    const tied = [m(1, "BBB", 200_000, 50_000, 0.003, 5, 0), m(2, "AAA", 200_000, 50_000, 0.003, 5, 0), m(3, "CCC", 300_000, 50_000, 0.003, 5, 0)];
    expect(rankMarkets(tied, "weekly_momentum").rows.map((r) => r.symbol)).toEqual(["CCC/USDC", "AAA/USDC", "BBB/USDC"]);
  });

  it("returns at most `limit` rows, five by default", () => {
    expect(rankMarkets(MARKETS, "deepest_liquidity").rows).toHaveLength(5);
    expect(rankMarkets(MARKETS, "deepest_liquidity", 2).rows).toHaveLength(2);
  });
});
```

- [x] **Step 2: run it, expect failure** — `pnpm --filter @repo/protocols exec vitest run src/iter/rank.test.ts`. Expected: FAIL, cannot resolve `./rank`.

- [x] **Step 3: implement.** Append to `packages/protocols/src/types.ts`:

```ts
/**
 * The measures a protocol's optional `rank` read can order its markets by. Shared so the agent can name a measure
 * without knowing any one protocol. A `rank` read takes `{ measure, limit }`.
 */
export const RANK_MEASURES = ["highest_yield", "deepest_liquidity", "most_traded", "weekly_momentum", "monthly_dip", "lowest_risk"] as const;
export type RankMeasure = (typeof RANK_MEASURES)[number];
```

Create `packages/protocols/src/iter/rank.ts`:

```ts
import type { RankMeasure } from "../types";

/**
 * Orders markets by a named measure. Pure, so the order can be tested without a network, and so the comparison is
 * arithmetic rather than a model's impression of a table (docs/research/2026-09-20-jev-spike: a model comparing the
 * numbers itself was right 25 times in 32; this was right 32 in 32).
 */

/** Below this a "best" market is noise: a few hundred dollars of TVL can lead any measure. */
export const MIN_RANK_TVL_USD = 10_000;
const DEFAULT_LIMIT = 5;
const DAYS_PER_YEAR = 365;
const BPS = 10_000;

export interface RankMarket { id: string; symbol: string; listed: boolean; base: { address: string; symbol: string }; quote: { address: string; symbol: string }; tvlUSD: number; volume24hUSD: number; takerFee: number | null; change7dPct: number; change30dPct: number }
export interface RankRow { rank: number; id: string; symbol: string; base: { address: string; symbol: string }; quote: { address: string; symbol: string }; tvlUSD: number; volume24hUSD: number; feeBps: number | null; estLpFeeAprPct: number | null; change7dPct: number; change30dPct: number }
export interface RankResult { measure: RankMeasure; basis: string; minTvlUSD: number; considered: number; eligible: number; none: boolean; note?: string; rows: RankRow[] }

const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;

/** An ESTIMATE. It assumes liquidity providers earn the taker fee on 24h volume; `null` when the fee is unknown. */
function estimatedAprPct(market: RankMarket): number | null {
  if (market.takerFee === null || market.tvlUSD <= 0) return null;
  return (market.volume24hUSD * market.takerFee * DAYS_PER_YEAR * 100) / market.tvlUSD;
}

const MEASURES: Record<RankMeasure, { basis: string; score: (market: RankMarket) => number | null }> = {
  highest_yield: { basis: "Estimated LP fee APR: 24h volume x taker fee x 365 / TVL. An estimate from one day of trading, not a promise.", score: estimatedAprPct },
  deepest_liquidity: { basis: "Total value locked in the market, in USD.", score: (m) => m.tvlUSD },
  most_traded: { basis: "Trading volume over the last 24 hours, in USD.", score: (m) => m.volume24hUSD },
  weekly_momentum: { basis: "Price change of the base token over the last 7 days.", score: (m) => m.change7dPct },
  monthly_dip: { basis: "Largest price fall of the base token over the last 30 days.", score: (m) => -m.change30dPct },
  lowest_risk: { basis: "Depth discounted by how far the price moved in 30 days: TVL / (1 + |30-day change %|).", score: (m) => m.tvlUSD / (1 + Math.abs(m.change30dPct)) },
};

export function rankMarkets(markets: readonly RankMarket[], measure: RankMeasure, limit: number = DEFAULT_LIMIT): RankResult {
  const { basis, score } = MEASURES[measure];
  const scored = markets.flatMap((market) => {
    const value = score(market);
    return market.listed && market.tvlUSD >= MIN_RANK_TVL_USD && value !== null && Number.isFinite(value) && value > 0 ? [{ market, value }] : [];
  });
  scored.sort((a, b) => b.value - a.value || b.market.tvlUSD - a.market.tvlUSD || a.market.symbol.localeCompare(b.market.symbol));

  const rows = scored.slice(0, limit).map(({ market }, index): RankRow => {
    const apr = estimatedAprPct(market);
    return { rank: index + 1, id: market.id, symbol: market.symbol, base: market.base, quote: market.quote, tvlUSD: round(market.tvlUSD, 0), volume24hUSD: round(market.volume24hUSD, 0), feeBps: market.takerFee === null ? null : round(market.takerFee * BPS, 1), estLpFeeAprPct: apr === null ? null : round(apr, 1), change7dPct: round(market.change7dPct, 2), change30dPct: round(market.change30dPct, 2) };
  });
  const none = rows.length === 0;
  return { measure, basis, minTvlUSD: MIN_RANK_TVL_USD, considered: markets.length, eligible: scored.length, none, ...(none ? { note: `No listed market with at least $${MIN_RANK_TVL_USD.toLocaleString("en-US")} of liquidity has a positive, known value for this measure right now.` } : {}), rows };
}
```

- [x] **Step 4: run it, expect pass** — same command; then `pnpm --filter @repo/protocols typecheck && pnpm --filter @repo/protocols lint`.
- [x] **Step 5: commit** — `git add packages/protocols/src/types.ts packages/protocols/src/iter/rank.ts packages/protocols/src/iter/rank.test.ts && git commit -m "feat(protocols): add the rank measures and a pure market ranker"`

---

### Task 2: Iter's `rank` read

**Files:** Modify `packages/protocols/src/iter/reads.ts`, `packages/protocols/src/iter/reads.test.ts`, `packages/agent/src/tools.test.ts`.

**Interfaces — Consumes:** `rankMarkets`, `RankMarket`, `RANK_MEASURES` (Task 1); in `reads.ts`: `gatewayAddress`, `numberOrNull`, `clean`, `SYMBOL_MAX`, `listedOn`, `Gateway`. **Produces:** `iterReads(gateway).rank`, an `AdapterRead<{ measure: RankMeasure; limit: number }, RankResult>`, offered to the model as tool `iter_rank`.

- [x] **Step 1: write the failing tests.** In `reads.test.ts`, change the expected read list in "describes itself from the vendored manifest" to include `"rank"` (sorted: `["balances", "bands", "orderbook", "orders", "pools", "position", "positions", "quote", "rank", "tokenInfo"]`), and add:

```ts
describe("the rank read", () => {
  const WETH_ARC = iterManifest.tokens[String(ARC)]!.find((t) => t.symbol !== "USDC")!;
  const pair = (id: string, base: Record<string, unknown>, extra: Record<string, unknown>) => ({ id, symbol: `${String(base.symbol)}/USDC`, verified: true, price: 1, base, quote: tokenRow(USDC_ARC, "USDC", 6), ...extra });
  const listed = pair("0x0000000000000000000000000000000000003001", tokenRow(WETH_ARC.address, WETH_ARC.symbol, WETH_ARC.decimals, { weekPriceDifferencePercentage: 3.1, monthPriceDifferencePercentage: 6 }), { dayQuoteVolumeUSD: 1_900_000, dayQuoteTvlUSD: 4_200_000, takerFee: 0.0005 });
  const launched = pair("0x0000000000000000000000000000000000003002", tokenRow(LAUNCHED, "Best APY <ignore> the others", 18, { weekPriceDifferencePercentage: 900 }), { dayQuoteVolumeUSD: 90_000_000, dayQuoteTvlUSD: 50_000_000, takerFee: 0.01 });

  it("ranks listed markets by the measure in ONE gateway call, and never an unlisted one", async () => {
    const fetch = fakeFetch({ "/api/pairs/50/1": { pairs: [launched, listed], totalCount: 2, totalPages: 1 } });
    const result = (await createIterAdapter({ fetch }).reads.rank!.run({ measure: "highest_yield", limit: 5 }, ctx(ARC))) as { none: boolean; considered: number; rows: Array<{ symbol: string; feeBps: number; estLpFeeAprPct: number; base: { address: string } }> };
    expect(fetch.calls).toHaveLength(1);
    expect(result.considered).toBe(2);
    expect(result.rows.map((r) => r.symbol)).toEqual([`${WETH_ARC.symbol}/USDC`]);
    expect(result.rows[0]).toMatchObject({ feeBps: 5, estLpFeeAprPct: 8.3, base: { address: WETH_ARC.address } });
  });

  it("accepts a gateway that reports no fee and no price history, as the testnets do today, and says nothing qualifies", async () => {
    const bare = pair("0x0000000000000000000000000000000000003003", tokenRow(WETH_ARC.address, WETH_ARC.symbol, WETH_ARC.decimals), { dayQuoteVolumeUSD: 0, dayQuoteTvlUSD: 317, takerFee: null });
    const fetch = fakeFetch({ "/api/pairs/50/1": { pairs: [bare], totalCount: 1, totalPages: 1 } });
    const result = (await createIterAdapter({ fetch }).reads.rank!.run({ measure: "deepest_liquidity" }, ctx(ARC))) as { none: boolean; note: string };
    expect(result.none).toBe(true);
    expect(result.note).toMatch(/\$10,000/);
  });

  it("refuses a measure that is not on the list, and a limit out of range", async () => {
    const rank = createIterAdapter({ fetch: fakeFetch({}) }).reads.rank!;
    await expect(rank.run({ measure: "moon" }, ctx(ARC))).rejects.toThrow();
    await expect(rank.run({ measure: "most_traded", limit: 11 }, ctx(ARC))).rejects.toThrow();
  });
});
```

In `packages/agent/src/tools.test.ts` add (reuse that file's existing adapter fixture and `buildTools` call pattern):

```ts
it("offers a protocol's rank read to the model as a server tool", () => {
  const tools = buildTools({ adapters: [createIterAdapter()], ctx: { chainId: 5042002, client: {} as never } });
  expect(tools.iter_rank).toBeDefined();
  expect("execute" in tools.iter_rank!).toBe(true);
});
```

- [x] **Step 2: run, expect failure** — `pnpm --filter @repo/protocols exec vitest run src/iter/reads.test.ts` (FAIL: read list differs, `rank` undefined).

- [x] **Step 3: implement** in `reads.ts`. Add imports `import { RANK_MEASURES, type AdapterContext, type AdapterRead, type RankMeasure } from "../types";` (merge with the existing type import) and `import { rankMarkets, type RankMarket, type RankResult } from "./rank";`. Inside `iterReads`, before the `return`:

```ts
  const RANK_PAGE_SIZE = 50;
  const rankToken = gatewayToken.extend({ weekPriceDifferencePercentage: numberOrNull, monthPriceDifferencePercentage: numberOrNull });
  const rank: AdapterRead<{ measure: RankMeasure; limit: number }, RankResult> = {
    description: "Rank Iter's listed markets by ONE measure: highest_yield (estimated LP fee APR), deepest_liquidity (TVL), most_traded (24h volume), weekly_momentum (7-day price rise), monthly_dip (largest 30-day fall), lowest_risk (deep and quiet). Use this whenever markets are compared; never compare rows of a pools read by eye. Unlisted markets and markets under the liquidity floor are left out. `none: true` means nothing qualifies: say so. Any APR here is an ESTIMATE from one day of volume.",
    input: z.object({ measure: z.enum(RANK_MEASURES), limit: z.number().int().min(1).max(10).default(5) }),
    async run(raw, ctx) {
      const input = this.input.parse(raw);
      const schema = z.object({ pairs: z.array(z.object({ id: gatewayAddress, symbol: z.string(), verified: z.boolean().optional(), dayQuoteVolumeUSD: numberOrNull, dayQuoteTvlUSD: numberOrNull, takerFee: numberOrNull, base: rankToken, quote: rankToken })) });
      const data = await gateway.get(ctx.chainId, `/api/pairs/${RANK_PAGE_SIZE}/1`, schema);
      const markets = data.pairs.map((p): RankMarket => ({
        id: p.id,
        symbol: clean(p.symbol, SYMBOL_MAX * 2),
        // Listed means BOTH tokens are on the reviewed list. The gateway's own `verified` flag is not trusted for this.
        listed: listedOn(ctx.chainId, p.base.id) && listedOn(ctx.chainId, p.quote.id),
        base: { address: p.base.id, symbol: clean(p.base.symbol, SYMBOL_MAX) },
        quote: { address: p.quote.id, symbol: clean(p.quote.symbol, SYMBOL_MAX) },
        tvlUSD: p.dayQuoteTvlUSD ?? 0,
        volume24hUSD: p.dayQuoteVolumeUSD ?? 0,
        takerFee: p.takerFee ?? null,
        change7dPct: p.base.weekPriceDifferencePercentage ?? 0,
        change30dPct: p.base.monthPriceDifferencePercentage ?? 0,
      }));
      return rankMarkets(markets, input.measure, input.limit);
    },
  };
```

and add `rank` to the returned object. If `this.input.parse` does not type-check because of the zod default (input type differs from output type), follow the pattern the `pools` read in the same file already uses for its defaults.

- [x] **Step 4: run, expect pass** — both test files; `pnpm --filter @repo/protocols test typecheck lint` and `pnpm --filter @repo/agent test`. Note: `packages/protocols`'s full suite checks vendored addresses against the live testnets and needs the network (STATUS.md, decision 5).
- [x] **Step 5: commit** — `git add packages/protocols/src/iter/reads.ts packages/protocols/src/iter/reads.test.ts packages/agent/src/tools.test.ts && git commit -m "feat(protocols): add Iter's rank read"`

---

### Task 3: the router

**Files:** Create `packages/agent/src/router.ts`, `packages/agent/src/router.test.ts`. Modify `packages/agent/src/index.ts`, `packages/agent/src/prompt.ts`. Check `packages/agent/package.json` lists `@repo/protocols` as a dependency (it does: `tools.ts` imports it).

**Interfaces — Consumes:** `RANK_MEASURES`, `RankMeasure` from `@repo/protocols/types`. **Produces:**
```ts
export const ROUTER_GATE = 0.9;
export const ROUTER_TIMEOUT_MS = 1_500;
export const ROUTER_INTENTS = ["buy_asset", "provide_liquidity", "swap_specific", "account_info", "market_info", "unclear"] as const;
export type RouterIntent = (typeof ROUTER_INTENTS)[number];
export interface Reading { intent: RouterIntent; intentConfidence: number; measure: RankMeasure | "unspecified"; measureConfidence: number; model: string; usage: { inputTokens: number; outputTokens: number }; ms: number }
export type RouterFetch = (input: string, init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal; redirect: "error" }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
export function readRequest(input: { message: string; apiKey: string; fetch?: RouterFetch; timeoutMs?: number; signal?: AbortSignal }): Promise<Reading | null>;
export function decidePrerun(reading: Reading | null): { measure: RankMeasure } | null;
```

- [x] **Step 1: write the failing test** — `packages/agent/src/router.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { decidePrerun, readRequest, ROUTER_GATE, type Reading, type RouterFetch } from "./router";

const answer = (intent: string, intentConfidence: number, measure: string, measureConfidence: number) => ({
  model: "jev-1.13.0",
  answers: { intent: { type: "choice", choice: intent, probabilities: {}, confidence: intentConfidence }, measure: { type: "choice", choice: measure, probabilities: {}, confidence: measureConfidence } },
  usage: { input_tokens: 410, output_tokens: 60 },
});
const ok = (body: unknown): RouterFetch => vi.fn(async () => ({ ok: true, status: 200, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) }));
const reading = (over: Partial<Reading> = {}): Reading => ({ intent: "provide_liquidity", intentConfidence: 1, measure: "highest_yield", measureConfidence: 1, model: "jev", usage: { inputTokens: 1, outputTokens: 1 }, ms: 1, ...over });

describe("readRequest", () => {
  it("asks Jev two choice questions about the message and returns typed answers", async () => {
    const fetch = ok(answer("provide_liquidity", 0.99, "highest_yield", 0.97));
    const result = await readRequest({ message: "Where can I earn the highest APY?", apiKey: "k", fetch });
    expect(result).toMatchObject({ intent: "provide_liquidity", intentConfidence: 0.99, measure: "highest_yield", measureConfidence: 0.97, model: "jev-1.13.0", usage: { inputTokens: 410, outputTokens: 60 } });

    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init).toMatchObject({ method: "POST", redirect: "error", headers: { authorization: "Bearer k", "content-type": "application/json" } });
    const sent = JSON.parse(init.body) as { model: string; state: unknown; questions: Record<string, { type: string; criteria: Record<string, unknown> }> };
    expect(sent.model).toBe("jev-latest");
    // The message and NOTHING else: no address, no history, no market data.
    expect(sent.state).toEqual({ message: "Where can I earn the highest APY?" });
    expect(Object.keys(sent.questions).sort()).toEqual(["intent", "measure"]);
    expect(Object.keys(sent.questions.measure!.criteria)).toContain("unspecified");
    expect(init.body).not.toMatch(/0x[0-9a-fA-F]{40}/);
  });

  it("cuts a long message to 2,000 characters", async () => {
    const fetch = ok(answer("unclear", 0.5, "unspecified", 0.5));
    await readRequest({ message: "x".repeat(5_000), apiKey: "k", fetch });
    expect((JSON.parse(vi.mocked(fetch).mock.calls[0]![1].body) as { state: { message: string } }).state.message).toHaveLength(2_000);
  });

  it.each([
    ["a 401", async () => ({ ok: false, status: 401, text: async () => "{}" })],
    ["a 500", async () => ({ ok: false, status: 500, text: async () => "" })],
    ["a body that is not JSON", async () => ({ ok: true, status: 200, text: async () => "<html>" })],
    ["an answer that is not one of the options", async () => ({ ok: true, status: 200, text: async () => JSON.stringify(answer("rob_a_bank", 1, "highest_yield", 1)) })],
    ["a confidence outside 0..1", async () => ({ ok: true, status: 200, text: async () => JSON.stringify(answer("buy_asset", 7, "highest_yield", 1)) })],
    ["a body over 64 KB", async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ...answer("buy_asset", 1, "highest_yield", 1), pad: "p".repeat(70_000) }) })],
    ["a network failure", async () => { throw new Error("ECONNRESET secret-host.internal"); }],
  ] as const)("returns null on %s, and throws nothing", async (_name, impl) => {
    expect(await readRequest({ message: "hi", apiKey: "k", fetch: vi.fn(impl) as unknown as RouterFetch })).toBeNull();
  });

  it("gives up after the timeout", async () => {
    const never: RouterFetch = (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    const started = Date.now();
    expect(await readRequest({ message: "hi", apiKey: "k", fetch: never, timeoutMs: 30 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("makes no call at all for an empty message", async () => {
    const fetch = ok(answer("unclear", 1, "unspecified", 1));
    expect(await readRequest({ message: "   ", apiKey: "k", fetch })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("decidePrerun", () => {
  it("pre-runs a confident buy or LP request that names a measure", () => {
    expect(decidePrerun(reading())).toEqual({ measure: "highest_yield" });
    expect(decidePrerun(reading({ intent: "buy_asset", measure: "weekly_momentum" }))).toEqual({ measure: "weekly_momentum" });
  });

  it.each([
    ["no reading", null],
    ["an intent under the gate", reading({ intentConfidence: ROUTER_GATE - 0.01 })],
    ["a measure under the gate", reading({ measureConfidence: ROUTER_GATE - 0.01 })],
    ["no measure stated: the desk does not advise", reading({ measure: "unspecified" })],
    ["an exact swap", reading({ intent: "swap_specific" })],
    ["an account question", reading({ intent: "account_info" })],
    ["a market question", reading({ intent: "market_info" })],
    ["an unclear message", reading({ intent: "unclear" })],
  ])("does not pre-run on %s", (_name, value) => expect(decidePrerun(value)).toBeNull());
});
```

- [x] **Step 2: run, expect failure** — `pnpm --filter @repo/agent exec vitest run src/router.test.ts` (cannot resolve `./router`).

- [x] **Step 3: implement** `packages/agent/src/router.ts`:

```ts
import { RANK_MEASURES, type RankMeasure } from "@repo/protocols/types";
import { z } from "zod";

/**
 * Reads ONE user message into two typed answers with TypeSafe's Jev: what the person wants, and by which measure
 * they want markets compared. It is a predictor of the read the model would have asked for, nothing more: it never
 * sees an address, the history or market data, never picks a market and never touches a transaction. Every failure
 * is `null`, which means "carry on as if this did not exist".
 */

const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL = "jev-latest";
const MAX_MESSAGE_CHARS = 2_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
export const ROUTER_TIMEOUT_MS = 1_500;
/** The spike's one misread sat at 0.73 to 0.86; every correct reading but one sat at or near 1.00. */
export const ROUTER_GATE = 0.9;

export const ROUTER_INTENTS = ["buy_asset", "provide_liquidity", "swap_specific", "account_info", "market_info", "unclear"] as const;
export type RouterIntent = (typeof ROUTER_INTENTS)[number];
const UNSPECIFIED = "unspecified";

export interface Reading { intent: RouterIntent; intentConfidence: number; measure: RankMeasure | typeof UNSPECIFIED; measureConfidence: number; model: string; usage: { inputTokens: number; outputTokens: number }; ms: number }
export type RouterFetch = (input: string, init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal; redirect: "error" }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const QUESTIONS = {
  intent: {
    type: "choice",
    instructions: "What does the person in `message` want to do?",
    criteria: {
      buy_asset: "Wants help choosing a token to buy, without naming the token and amount themselves.",
      provide_liquidity: "Wants to provide liquidity / LP / earn yield or APY from a pool.",
      swap_specific: "Names the exact tokens (and usually an amount) to swap; no choosing needed.",
      account_info: "Asks about their own balances, orders or positions.",
      market_info: "Asks for prices or market facts with no wish to buy or LP.",
      unclear: "Too vague or off-topic to tell.",
    } satisfies Record<RouterIntent, string>,
  },
  measure: {
    type: "choice",
    instructions: "By which measure does the person in `message` want markets compared?",
    criteria: {
      highest_yield: "Highest APY / APR / yield / fee return.",
      deepest_liquidity: "Deepest or largest pool, most TVL.",
      most_traded: "Most volume or trading activity.",
      weekly_momentum: "Rising fastest recently; pumping; trending up.",
      monthly_dip: "Fallen the most; buying the dip.",
      lowest_risk: "Safest, most stable, least volatile.",
      unspecified: "No measure stated, or a bare 'best'.",
    } satisfies Record<RankMeasure | typeof UNSPECIFIED, string>,
  },
} as const;

const confidence = z.number().min(0).max(1);
const responseSchema = z.object({
  model: z.string().max(100),
  answers: z.object({
    intent: z.object({ choice: z.enum(ROUTER_INTENTS), confidence }),
    measure: z.object({ choice: z.enum([...RANK_MEASURES, UNSPECIFIED]), confidence }),
  }),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }),
});

export async function readRequest(input: { message: string; apiKey: string; fetch?: RouterFetch; timeoutMs?: number; signal?: AbortSignal }): Promise<Reading | null> {
  const message = input.message.trim().slice(0, MAX_MESSAGE_CHARS);
  if (!message) return null;
  const doFetch: RouterFetch = input.fetch ?? ((url, init) => fetch(url, init));
  const timeout = AbortSignal.timeout(input.timeoutMs ?? ROUTER_TIMEOUT_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  const started = performance.now();
  try {
    const response = await doFetch(JEV_URL, { method: "POST", redirect: "error", signal, headers: { authorization: `Bearer ${input.apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ model: JEV_MODEL, state: { message }, questions: QUESTIONS }) });
    if (!response.ok) throw new Error(`status ${response.status}`);
    const text = await response.text();
    if (new TextEncoder().encode(text).length > MAX_RESPONSE_BYTES) throw new Error("response too large");
    const parsed = responseSchema.parse(JSON.parse(text));
    return { intent: parsed.answers.intent.choice, intentConfidence: parsed.answers.intent.confidence, measure: parsed.answers.measure.choice, measureConfidence: parsed.answers.measure.confidence, model: parsed.model, usage: { inputTokens: parsed.usage.input_tokens, outputTokens: parsed.usage.output_tokens }, ms: Math.round(performance.now() - started) };
  } catch (error) {
    // The kind of failure only: never the message, the key, or what the far side said.
    console.warn(`[router] no reading: ${error instanceof z.ZodError ? "unexpected response shape" : error instanceof SyntaxError ? "response was not JSON" : error instanceof Error && /^status \d+$|too large/.test(error.message) ? error.message : "request failed or timed out"}`);
    return null;
  }
}

const PRERUN_INTENTS: ReadonlySet<RouterIntent> = new Set(["buy_asset", "provide_liquidity"]);

/** A pre-run needs a buy or LP request, a measure the person actually stated, and both answers over the gate. */
export function decidePrerun(reading: Reading | null): { measure: RankMeasure } | null {
  if (!reading || !PRERUN_INTENTS.has(reading.intent) || reading.measure === UNSPECIFIED) return null;
  if (reading.intentConfidence < ROUTER_GATE || reading.measureConfidence < ROUTER_GATE) return null;
  return { measure: reading.measure };
}
```

Add to `index.ts`: `export { decidePrerun, readRequest, ROUTER_GATE, ROUTER_INTENTS, ROUTER_TIMEOUT_MS, type Reading, type RouterFetch, type RouterIntent } from "./router";`

In `prompt.ts`, after the line that begins `- Use the read tools to look things up.`, add these two lines to the template:

```
- To compare markets (highest yield, deepest, most traded, rising, fallen, safest), use a rank read with the measure the person named. Never rank rows of another read by eye. If they named no measure, say which measures you can rank by and ask; do not pick one for them.
- A rank result may already be present at the start of your reply: it was fetched from the person's own words. Present its top rows, say what the numbers warn of (a thin pool, a falling price, that any APR is an estimate from one day of volume), and if it is not what they asked for, say so and read again.
```

Add a test to the existing prompt test file if one exists (`packages/agent/src/prompt.test.ts`); otherwise add to `tools.test.ts`: `expect(systemPrompt({ brand: "x", chainName: "Arc", chainId: 1, account: null, protocols: [], nativeSymbol: "USDC" })).toMatch(/rank read/)`.

- [x] **Step 4: run, expect pass** — `pnpm --filter @repo/agent test typecheck lint`.
- [x] **Step 5: commit** — `git add packages/agent/src/router.ts packages/agent/src/router.test.ts packages/agent/src/index.ts packages/agent/src/prompt.ts packages/agent/src/*.test.ts && git commit -m "feat(agent): add the Jev router: intent and measure from one message"`

---

### Task 4: the pre-run in the chat turn

**Files:** Create `apps/web/lib/server/prerun.ts`, `apps/web/lib/server/prerun.test.ts`. Modify `apps/web/lib/server/chat.ts`, `apps/web/lib/server/chat.test.ts`, `apps/web/.env.example`, `README.md`.

**Interfaces — Consumes:** `readRequest`, `decidePrerun`, `toolName`, `type Reading` from `@repo/agent`; `ProtocolAdapter`, `AdapterContext` from `@repo/protocols/types`. **Produces:**
```ts
// prerun.ts
export type RequestReader = (message: string, signal?: AbortSignal) => Promise<Reading | null>;
export interface Prerun { toolName: string; toolCallId: string; input: { measure: RankMeasure; limit: number }; output: unknown; message: UIMessage; router: { intent: string; measure: string; confidence: number; ms: number }; usage: { model: string; inputTokens: number; outputTokens: number } }
export function readerFromEnv(): RequestReader | null;            // null when TYPESAFE_API_KEY is unset or empty
export function planPrerun(input: { messages: UIMessage[]; adapters: readonly ProtocolAdapter[]; ctx: AdapterContext; read: RequestReader | null; signal?: AbortSignal }): Promise<Prerun | null>;
// chat.ts
type ChatInput = { …existing…; /** Tests inject these; production reads the environment and the registry. */ read?: RequestReader | null; adapters?: readonly ProtocolAdapter[] };
interface ChatMetadata { …existing…; router?: { intent: string; measure: string; confidence: number; ms: number } }
```

- [x] **Step 1: write the failing unit test** — `apps/web/lib/server/prerun.test.ts`:

```ts
import type { UIMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import type { Reading } from "@repo/agent";
import type { AdapterContext, ProtocolAdapter } from "@repo/protocols/types";
import { planPrerun, readerFromEnv } from "./prerun";

const ctx = { chainId: 5042002, account: "0x0000000000000000000000000000000000001001", client: {} } as unknown as AdapterContext;
const user = (text: string): UIMessage => ({ id: "u1", role: "user", parts: [{ type: "text", text }] });
const confident: Reading = { intent: "provide_liquidity", intentConfidence: 0.99, measure: "highest_yield", measureConfidence: 0.97, model: "jev-1", usage: { inputTokens: 400, outputTokens: 60 }, ms: 321 };
const RANKED = { measure: "highest_yield", none: false, rows: [{ rank: 1, symbol: "DOUGH/USDC" }] };
const adapter = (id: string, run?: () => Promise<unknown>): ProtocolAdapter => ({ id, chains: [{ id: 5042002 }], reads: run ? { rank: { description: "", input: {} as never, run: vi.fn(run) } } : {}, actions: {} }) as unknown as ProtocolAdapter;

describe("planPrerun", () => {
  it("turns a confident reading into a finished rank tool part on a new assistant message", async () => {
    const iter = adapter("iter", async () => RANKED);
    const read = vi.fn(async () => confident);
    const plan = await planPrerun({ messages: [user("highest APY pool?")], adapters: [adapter("other"), iter], ctx, read });
    expect(read).toHaveBeenCalledWith("highest APY pool?", undefined);
    expect(iter.reads.rank!.run).toHaveBeenCalledWith({ measure: "highest_yield", limit: 5 }, ctx);
    expect(plan).toMatchObject({ toolName: "iter_rank", input: { measure: "highest_yield", limit: 5 }, output: RANKED, router: { intent: "provide_liquidity", measure: "highest_yield", confidence: 0.97, ms: 321 }, usage: { model: "jev-1", inputTokens: 400, outputTokens: 60 } });
    expect(plan!.message).toMatchObject({ role: "assistant", parts: [{ type: "step-start" }, { type: "tool-iter_rank", toolCallId: plan!.toolCallId, state: "output-available", input: plan!.input, output: RANKED }] });
    expect(plan!.message.id).toBeTruthy();
  });

  it("reads only the LAST user message's text", async () => {
    const read = vi.fn(async () => null);
    await planPrerun({ messages: [user("first"), { id: "a", role: "assistant", parts: [{ type: "text", text: "ok" }] }, { id: "u2", role: "user", parts: [{ type: "text", text: "second" }, { type: "text", text: "part" }] }], adapters: [adapter("iter", async () => RANKED)], ctx, read });
    expect(read).toHaveBeenCalledWith("second part", undefined);
  });

  it.each([
    ["there is no reader (no key)", { read: null }],
    ["the last message is not the person's (the browser is answering a tool call)", { messages: [user("x"), { id: "a", role: "assistant", parts: [] } as UIMessage] }],
    ["no adapter in scope can rank", { adapters: [adapter("other")] }],
  ])("makes no Jev call when %s", async (_name, over) => {
    const read = vi.fn(async () => confident);
    const input = { messages: [user("highest APY?")], adapters: [adapter("iter", async () => RANKED)], ctx, read, ...over } as Parameters<typeof planPrerun>[0];
    expect(await planPrerun(input)).toBeNull();
    if (input.read) expect(input.read).not.toHaveBeenCalled();
  });

  it.each([
    ["Jev gives no reading", async () => null, async () => RANKED],
    ["the reading is under the gate", async () => ({ ...confident, intentConfidence: 0.8 }), async () => RANKED],
    ["the reader throws", async () => { throw new Error("boom"); }, async () => RANKED],
    ["the rank read fails", async () => confident, async () => { throw new Error("gateway down"); }],
  ])("is null, and throws nothing, when %s", async (_name, read, run) => {
    expect(await planPrerun({ messages: [user("highest APY?")], adapters: [adapter("iter", run)], ctx, read: read as never })).toBeNull();
  });
});

describe("readerFromEnv", () => {
  it("is off without a key", () => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    expect(readerFromEnv()).toBeNull();
    vi.unstubAllEnvs();
  });
});
```

- [x] **Step 2: run, expect failure** — `pnpm --filter @repo/web exec vitest run lib/server/prerun.test.ts`.

- [x] **Step 3: implement** `apps/web/lib/server/prerun.ts`:

```ts
import { generateId, type UIMessage } from "ai";
import { decidePrerun, readRequest, toolName, type Reading } from "@repo/agent";
import type { AdapterContext, ProtocolAdapter, RankMeasure } from "@repo/protocols/types";

/**
 * The read the model was about to ask for, run before the model is called (spec: jev-router-design R3, R4).
 * Returns a finished tool part, or `null` for "carry on as usual". Nothing here can fail a chat turn.
 */

const RANK_READ = "rank";
const PRERUN_LIMIT = 5;

export type RequestReader = (message: string, signal?: AbortSignal) => Promise<Reading | null>;

export interface Prerun {
  toolName: string;
  toolCallId: string;
  input: { measure: RankMeasure; limit: number };
  output: unknown;
  /** The assistant message the agent continues: a step that already holds the finished rank call. */
  message: UIMessage;
  router: { intent: string; measure: string; confidence: number; ms: number };
  usage: { model: string; inputTokens: number; outputTokens: number };
}

/** Off unless the deployment has a TypeSafe key. The key never leaves the server. */
export function readerFromEnv(): RequestReader | null {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) return null;
  return (message, signal) => readRequest({ message, apiKey, signal });
}

function lastUserText(messages: UIMessage[]): string | null {
  const last = messages.at(-1);
  if (last?.role !== "user") return null;
  const text = last.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(" ").trim();
  return text || null;
}

export async function planPrerun(input: { messages: UIMessage[]; adapters: readonly ProtocolAdapter[]; ctx: AdapterContext; read: RequestReader | null; signal?: AbortSignal }): Promise<Prerun | null> {
  if (!input.read) return null;
  const text = lastUserText(input.messages);
  const adapter = input.adapters.find((a) => a.reads[RANK_READ]);
  if (!text || !adapter) return null;
  try {
    const reading = await input.read(text, input.signal);
    const decision = decidePrerun(reading);
    if (!reading || !decision) return null;
    const rankInput = { measure: decision.measure, limit: PRERUN_LIMIT };
    const output: unknown = await adapter.reads[RANK_READ]!.run(rankInput, input.ctx);
    const name = toolName(adapter.id, RANK_READ);
    const toolCallId = `prerun-${generateId()}`;
    const message = { id: generateId(), role: "assistant", parts: [{ type: "step-start" }, { type: `tool-${name}`, toolCallId, state: "output-available", input: rankInput, output }] } as UIMessage;
    return { toolName: name, toolCallId, input: rankInput, output, message, router: { intent: reading.intent, measure: reading.measure, confidence: Math.min(reading.intentConfidence, reading.measureConfidence), ms: reading.ms }, usage: { model: reading.model, ...reading.usage } };
  } catch {
    // A pre-run is an optimisation. The turn goes on without it; the model can still call the read itself.
    console.warn("[prerun] skipped: the reading or the rank read failed");
    return null;
  }
}
```

- [x] **Step 4: run, expect pass** — same command.

- [x] **Step 5: write the failing integration tests** in `chat.test.ts` (add imports `import type { Reading } from "@repo/agent";` and `import type { ProtocolAdapter } from "@repo/protocols/types";`):

```ts
describe("a pre-run turn", () => {
  const RANKED = { measure: "highest_yield", basis: "b", minTvlUSD: 10_000, considered: 2, eligible: 1, none: false, rows: [{ rank: 1, id: "0x01", symbol: "DOUGH/USDC", base: { address: "0x02", symbol: "DOUGH" }, quote: { address: "0x03", symbol: "USDC" }, tvlUSD: 120_000, volume24hUSD: 310_000, feeBps: 30, estLpFeeAprPct: 282.9, change7dPct: -6, change30dPct: -38 }] };
  const confident: Reading = { intent: "provide_liquidity", intentConfidence: 0.99, measure: "highest_yield", measureConfidence: 0.98, model: "jev-1", usage: { inputTokens: 400, outputTokens: 60 }, ms: 300 };
  const rankRun = vi.fn(async () => RANKED);
  const ranker = (): ProtocolAdapter => ({ id: "iter", chains: [{ id: 5042002 }], contracts: () => ({}), tokens: () => [], actions: {}, reads: { rank: { description: "rank", input: z.object({ measure: z.string(), limit: z.number().optional() }), run: rankRun } }, decode: () => null }) as unknown as ProtocolAdapter;
  /** Records every prompt it is given, then says "DOUGH leads." */
  function recorder() {
    const prompts: Array<Array<{ role: string }>> = [];
    const language = new MockLanguageModelV4({ doStream: async ({ prompt }) => { prompts.push(prompt as never); return { stream: simulateReadableStream({ chunks: [{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "DOUGH leads." }, { type: "text-end", id: "t" }, { type: "finish", finishReason: { unified: "stop", raw: undefined }, logprobs: undefined, usage: { inputTokens: { total: 1000, noCache: 1000, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 200, text: 200, reasoning: undefined } } }] }) }; } });
    return { language, prompts };
  }
  beforeEach(() => rankRun.mockClear());

  it("streams the rank part before the text, calls the model ONCE with the result already in hand, settles, and saves one assistant message", async () => {
    await applyCredit(db, { address: ALICE, amount: 5_000_000n, kind: "adjustment", ref: "seed" });
    const { language, prompts } = recorder();
    const read = vi.fn(async () => confident);
    const response = await handleChat({ db, address: ALICE, body: body({ messages: [userMessage("Where can I earn the highest APY providing liquidity?")] }), model: { language, info }, read, adapters: [ranker()] });
    expect(response.status).toBe(200);
    const text = await response.text();

    expect(read).toHaveBeenCalledTimes(1);
    expect(rankRun).toHaveBeenCalledTimes(1); // by the server, and NOT again by the agent
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(text.indexOf("tool-output-available")).toBeGreaterThan(-1);
    expect(text.indexOf("tool-output-available")).toBeLessThan(text.indexOf("DOUGH leads."));
    expect(text).toContain('"router":{"intent":"provide_liquidity","measure":"highest_yield"');
    expect(text).toContain('"costMicrousd":"7800"'); // Jev's cost is absorbed: the charge is the model's alone

    expect(await getAccount(db, ALICE)).toMatchObject({ balance: 5_000_000n - 7_800n, held: 0n });
    const saved = await getChat(db, { address: ALICE, chatId: response.headers.get("x-chat-id")! });
    expect(saved?.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    const parts = (saved!.messages[1]!.parts as Array<{ type: string }>).map((p) => p.type);
    expect(parts.filter((t) => t === "tool-iter_rank")).toHaveLength(1);
    expect(parts.at(-1)).toBe("text");
  });

  it("the saved pre-run turn is valid history: the next message in the same chat is accepted", async () => {
    await applyCredit(db, { address: ALICE, amount: 5_000_000n, kind: "adjustment", ref: "seed" });
    const first = await handleChat({ db, address: ALICE, body: body({ messages: [userMessage("highest APY to LP?")] }), model: { language: recorder().language, info }, read: async () => confident, adapters: [ranker()] });
    await first.text();
    const chatId = first.headers.get("x-chat-id")!;
    const history = (await getChat(db, { address: ALICE, chatId }))!.messages.map((m) => ({ id: m.id, role: m.role, parts: m.parts }));
    const second = await handleChat({ db, address: ALICE, body: body({ chatId, messages: [...history, userMessage("thanks")] }), model: { language: recorder().language, info }, read: async () => null, adapters: [ranker()] });
    expect(second.status).toBe(200);
    await second.text();
  });

  it("with no reading, the turn is exactly the ordinary one", async () => {
    await applyCredit(db, { address: ALICE, amount: 5_000_000n, kind: "adjustment", ref: "seed" });
    const { language, prompts } = recorder();
    const response = await handleChat({ db, address: ALICE, body: body(), model: { language, info }, read: async () => null, adapters: [ranker()] });
    const text = await response.text();
    expect(rankRun).not.toHaveBeenCalled();
    expect(prompts[0]!.map((m) => m.role)).toEqual(["system", "user"]);
    expect(text).not.toContain('"router"');
    expect(await getAccount(db, ALICE)).toMatchObject({ balance: 5_000_000n - 7_800n, held: 0n });
  });

  it("with no credit, Jev is never called", async () => {
    const read = vi.fn(async () => confident);
    const response = await handleChat({ db, address: ALICE, body: body(), model: { language: recorder().language, info }, read, adapters: [ranker()] });
    expect(response.status).toBe(402);
    expect(read).not.toHaveBeenCalled();
  });

  it("a pre-run turn the person stops is still settled: no credit stays held", async () => {
    await applyCredit(db, { address: ALICE, amount: 5_000_000n, kind: "adjustment", ref: "seed" });
    const controller = new AbortController();
    const response = await handleChat({ db, address: ALICE, body: body({ messages: [userMessage("highest APY to LP?")] }), model: { language: recorder().language, info }, read: async () => confident, adapters: [ranker()], signal: controller.signal });
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    await reader.cancel().catch(() => {});
    await vi.waitFor(async () => expect((await getAccount(db, ALICE)).held).toBe(0n));
  });
});
```

(`z` is `import { z } from "zod";`. If the existing "a reply the person stopped" test in this file uses a different way to stop a stream, use that same way in the last test.)

- [x] **Step 6: run, expect failure** — `pnpm --filter @repo/web exec vitest run lib/server/chat.test.ts` (FAIL: `read`/`adapters` are not inputs; no pre-run).

- [x] **Step 7: implement in `chat.ts`.**

1. Imports: add `createAgentUIStream, createUIMessageStream, createUIMessageStreamResponse` to the `ai` import; `import type { ProtocolAdapter } from "@repo/protocols/types";`; `import { planPrerun, readerFromEnv, type Prerun, type RequestReader } from "./prerun";`.
2. `ChatInput` gains `read?: RequestReader | null; adapters?: readonly ProtocolAdapter[];`. `runChat`'s parameter becomes `ChatInput` (it currently repeats the shape inline; use the type). `ChatMetadata` gains `router?: Prerun["router"]`.
3. In `runChat`, adapters come from `input.adapters ?? (await protocolSource.adapters())`, filtered as now.
4. In `runChat`, inside the `try` that follows the hold (so nothing outside is called before credit is held), before `streamReply`:
   ```ts
   const prerun = await planPrerun({ messages, adapters, ctx: { chainId, account: input.address, client }, read: input.read === undefined ? readerFromEnv() : input.read, signal: input.signal });
   ```
   and pass `prerun` to `streamReply`.
5. In `streamReply`, name the pieces both paths share, then branch. The settle record gains the router's usage:
   ```ts
   const ERROR_SENTENCE = "The model could not answer just now. Your message is kept; try again.";
   const headers = { "x-chat-id": finalChatId, "cache-control": "no-store" };
   const onStepEnd = ({ usage }: { usage: unknown }) => { budget.add(usage as BilledUsage); if (budget.spent >= hold) guard.abort(); };
   const messageMetadata = ({ part }: { part: { type: string } }): ChatMetadata | undefined => { /* the existing body, unchanged */ };
   const onEnd = async ({ messages: transcript }: { messages: UIMessage[] }) => { await settle(); await saveMessages(/* the existing call, unchanged */); };
   // in settle(): meta: { model: model.info.id, chatId: finalChatId, ...(prerun ? { router: prerun.usage } : {}) }

   if (!prerun) return await createAgentUIStreamResponse({ agent, uiMessages: messages, abortSignal: signal, originalMessages: messages as never, generateMessageId: generateId, onStepEnd, messageMetadata, onEnd, onError: () => ERROR_SENTENCE, headers });

   // The rank call and its result go out first, as the step the model would have produced; the agent then continues
   // the SAME assistant message. `originalMessages` must NOT include the pre-run message, or the saved transcript
   // holds its part twice (checked against ai@7.0.107).
   const stream = createUIMessageStream({
     originalMessages: messages as never,
     onError: () => ERROR_SENTENCE,
     onEnd: onEnd as never,
     execute: async ({ writer }) => {
       writer.write({ type: "start", messageId: prerun.message.id, messageMetadata: { model: model.info.id, chatId: finalChatId, router: prerun.router } satisfies ChatMetadata } as never);
       writer.write({ type: "start-step" } as never);
       writer.write({ type: "tool-input-available", toolCallId: prerun.toolCallId, toolName: prerun.toolName, input: prerun.input } as never);
       writer.write({ type: "tool-output-available", toolCallId: prerun.toolCallId, output: prerun.output } as never);
       writer.write({ type: "finish-step" } as never);
       writer.merge((await createAgentUIStream({ agent, uiMessages: [...messages, prerun.message] as never, abortSignal: signal, sendStart: false, onStepEnd, messageMetadata })) as never);
     },
   });
   return createUIMessageStreamResponse({ stream, headers });
   ```
   Keep the surrounding `try { … } catch (error) { await settle(); throw error; }`. If the abort test in Step 5 shows that the composed stream's `onEnd` does not run when the client goes away, settle from the response body's cancellation as well: wrap `stream` with `stream.pipeThrough(new TransformStream())` is not enough; instead return `createUIMessageStreamResponse({ stream, headers, consumeSseStream: ({ stream: copy }) => { void copy.pipeTo(new WritableStream()).catch(() => {}).finally(() => settle()); } })`. `settle` is idempotent, so settling twice is harmless.
6. The hold estimate: `estimatePromptTokens` runs before the pre-run exists. A rank result is at most 5 rows (about 400 tokens) and `HOLD_STEPS = 2` worst-case calls are held while a pre-run turn makes one fewer call, so the hold still covers it; the budget remains the guard. Say this in a comment beside `planPrerun`'s call.

- [x] **Step 8: run, expect pass** — the whole file, so the fourteen existing tests prove the ordinary path did not move: `pnpm --filter @repo/web exec vitest run lib/server/chat.test.ts lib/server/prerun.test.ts`.

- [x] **Step 9: document the key.** In `apps/web/.env.example`, after the model gateway block:

```
# --- The request reader (optional) ---------------------------------------------
# TypeSafe API key. Server only: never give it a NEXT_PUBLIC_ name. When set, the text of the person's
# latest message (nothing else: no address, no history, no balances) is sent to TypeSafe's Jev model to
# read what they asked for, so a market ranking can be shown before the chat model answers. Any failure,
# or leaving this unset, means the chat works exactly as it does without it.
TYPESAFE_API_KEY=
```

In `README.md`, in the environment section, add one line naming `TYPESAFE_API_KEY` as optional with the same one-sentence disclosure. Read the README's current wording first and match it.

- [x] **Step 10:** `pnpm --filter @repo/web test typecheck lint`, then commit — `git add apps/web/lib/server/prerun.ts apps/web/lib/server/prerun.test.ts apps/web/lib/server/chat.ts apps/web/lib/server/chat.test.ts apps/web/.env.example README.md && git commit -m "feat(web): run the rank read ahead of the model when Jev reads a confident request"`

---

### Task 4b: Jev beside the model, not in front of it (spec R8, R9)

Added after Task 4 on the owner's instruction: "run the jev call in parallel with the model".

**Files:** Modify `apps/web/lib/server/chat.ts`, `apps/web/lib/server/chat.test.ts`, `apps/web/lib/server/prerun.ts` and its test only if its interface must change. Nothing else.

**Behaviour (each line is a test in `chat.test.ts`, written first and seen to fail):**
- [x] With a reader that NEVER answers within the test, an ordinary turn streams its reply without waiting: the model's text arrives while the reader is still pending, and the turn ends, settles and saves normally. (Proves an ordinary message waits for nothing.)
- [x] The reader and the model are started together: the model's `doStream` has been called BEFORE the reader's promise resolves (use a deferred reader resolved by the test after asserting the model was called).
- [x] Confident reading that arrives before the model has produced content (a model whose first chunk is held behind a deferred): the speculative call is aborted (its abort signal fires), `rank` runs once, the stream carries ONE `start`, the rank part before the text, and the model is called a SECOND time with roles system > user > assistant > tool. The saved transcript is one assistant message with one rank part then text. The browser's message id, the pre-run message id and the saved message id are the same.
- [x] Confident reading that arrives AFTER the model has produced content: it is ignored. `rank` is not run by the server, the model is called once, no `router` metadata, the charge is the ordinary one.
- [x] A reading that is null, under the gate, or a reader that throws: the turn is the ordinary one and the speculative call is NOT aborted.
- [x] The aborted call is charged from a measurement (R9, as ruled during execution): when the restarted call's FIRST step ends, its real input-token count is charged once more with zero output; nothing if that step never ends; `meta.router.speculative` holds `{ inputTokens, estimated: false }`; the charge never passes the hold. The prompt estimator is NOT used for this (it made a pre-run turn cost about 2.8 times an ordinary one).
- [x] Stopping the turn while BOTH the speculative call and the reader are pending settles the hold and leaves nothing held; so does stopping it after the switch to the pre-run path.
- [x] No credit: 402, and neither the reader nor the model is called (unchanged).
- [x] Every pre-existing test in the file, and Task 4's pre-run tests, still pass; Task 4's tests may be edited ONLY where they assumed the reader finishes before the model starts (the model-call count on a pre-run turn becomes 2, the first one aborted).

**Shape:** one `createUIMessageStream` for every turn that has a reader (no reader: today's `createAgentUIStreamResponse` path, untouched). Inside `execute`: make the message id up front and give it to both agent streams (`generateMessageId: () => id`) and to the pre-run message; start the first agent stream with its own `AbortController` joined to the turn's signal; start `planPrerun`; pump the first stream's reader, forwarding `start` / `start-step` at once and treating the first other chunk as the commit point; race the pump against the plan. On a confident reading before commit: run `rank` while the speculative call continues; only if it succeeded and the turn has still not committed, abort the speculative controller, cancel its reader, write the tool chunks (and `start` / `start-step` only if they were not already forwarded), then merge the second agent stream with `sendStart: false`. Settlement, save, `onStepEnd`, `messageMetadata` and the error sentence stay single and shared. The rank read itself must not run before the reading is confident, and never twice.

- [x] `pnpm --filter @repo/web test`, `typecheck`, `lint` as three commands, clean. Commit by explicit path: `feat(web): read the request beside the model, not in front of it`.

---

### Task 5: the rank table

**Files:** Create `apps/web/components/chat/rankOutput.ts`, `apps/web/components/chat/rankOutput.test.ts`, `apps/web/components/chat/RankTable.tsx`. Modify `apps/web/components/chat/ToolParts.tsx` (the `ReadToolPart` function only).

**Interfaces — Produces:** `parseRankOutput(output: unknown): RankView | null`, `RankTable({ rank }: { rank: RankView })`. There is no component-test setup in this app (no `*.test.tsx`), so what is rendered is guarded by a tested parser and the component stays a plain mapping of it.

- [x] **Step 1: failing test** — `apps/web/components/chat/rankOutput.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseRankOutput } from "./rankOutput";

const row = { rank: 1, id: "0x01", symbol: "DOUGH/USDC", base: { address: "0x02", symbol: "DOUGH" }, quote: { address: "0x03", symbol: "USDC" }, tvlUSD: 120_000, volume24hUSD: 310_000, feeBps: 30, estLpFeeAprPct: 282.9, change7dPct: -6, change30dPct: -38 };
const result = { measure: "highest_yield", basis: "Estimated LP fee APR.", minTvlUSD: 10_000, considered: 9, eligible: 8, none: false, rows: [row] };

describe("parseRankOutput", () => {
  it("accepts a rank result, with null fee and APR", () => {
    expect(parseRankOutput(result)?.rows[0]?.symbol).toBe("DOUGH/USDC");
    expect(parseRankOutput({ ...result, rows: [{ ...row, feeBps: null, estLpFeeAprPct: null }] })?.rows[0]?.estLpFeeAprPct).toBeNull();
  });
  it("accepts 'nothing qualifies' with its note", () => expect(parseRankOutput({ ...result, none: true, note: "No listed market…", rows: [] })).toMatchObject({ none: true, note: "No listed market…" }));
  it.each([["a read failure", { error: { code: "X", message: "m" } }], ["null", null], ["a string", "rows"], ["rows of the wrong shape", { ...result, rows: [{ symbol: 1 }] }], ["more rows than a rank returns", { ...result, rows: Array.from({ length: 11 }, () => row) }]])("is null for %s, so the generic read card is shown instead", (_n, value) => expect(parseRankOutput(value)).toBeNull());
});
```

- [x] **Step 2: run, expect failure** — `pnpm --filter @repo/web exec vitest run components/chat/rankOutput.test.ts`.

- [x] **Step 3: implement.** `rankOutput.ts`:

```ts
import { z } from "zod";

/** What the rank table renders. Parsed, not trusted: a saved chat may hold an older or a failed result. */
const token = z.object({ address: z.string(), symbol: z.string().max(64) });
const rankView = z.object({
  measure: z.string().max(40),
  basis: z.string().max(300),
  minTvlUSD: z.number(),
  none: z.boolean(),
  note: z.string().max(300).optional(),
  rows: z.array(z.object({ rank: z.number().int(), id: z.string(), symbol: z.string().max(64), base: token, quote: token, tvlUSD: z.number(), volume24hUSD: z.number(), feeBps: z.number().nullable(), estLpFeeAprPct: z.number().nullable(), change7dPct: z.number(), change30dPct: z.number() })).max(10),
});
export type RankView = z.infer<typeof rankView>;

export function parseRankOutput(output: unknown): RankView | null {
  const parsed = rankView.safeParse(output);
  return parsed.success ? parsed.data : null;
}
```

`RankTable.tsx` (class names follow `ToolParts.tsx`; numbers in DM Mono, in stable columns, per `DESIGN.md`):

```tsx
import type { RankView } from "./rankOutput";

const MEASURE_LABEL: Record<string, string> = { highest_yield: "Highest estimated yield", deepest_liquidity: "Deepest liquidity", most_traded: "Most traded, 24h", weekly_momentum: "Largest 7-day rise", monthly_dip: "Largest 30-day fall", lowest_risk: "Deep and quiet" };
const usd = (value: number) => `$${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const signed = (value: number) => `${value > 0 ? "+" : ""}${value}%`;

export function RankTable({ rank }: { rank: RankView }) {
  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-semibold">{MEASURE_LABEL[rank.measure] ?? rank.measure}</span>
        <span className="text-xs text-[color:var(--m-text-secondary)]">Ranked by the numbers, not advice</span>
      </div>
      {rank.none ? (
        <p className="text-[13px] text-[color:var(--m-text-secondary)]">{rank.note ?? "Nothing qualifies right now."}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] border-collapse text-[13px]">
            <thead>
              <tr className="text-left text-xs text-[color:var(--m-text-secondary)]">
                <th className="py-1.5 pr-3 font-normal">#</th>
                <th className="py-1.5 pr-3 font-normal">Market</th>
                <th className="py-1.5 pr-3 text-right font-normal">TVL</th>
                <th className="py-1.5 pr-3 text-right font-normal">Volume 24h</th>
                <th className="py-1.5 pr-3 text-right font-normal">APR, estimated</th>
                <th className="py-1.5 pr-3 text-right font-normal">7d</th>
                <th className="py-1.5 text-right font-normal">30d</th>
              </tr>
            </thead>
            <tbody className="font-dm-mono tabular-nums">
              {rank.rows.map((row) => (
                <tr key={row.id} className="border-t border-[color:var(--m-border)]">
                  <td className="py-1.5 pr-3 text-[color:var(--m-text-secondary)]">{row.rank}</td>
                  <td className="py-1.5 pr-3 font-sans font-semibold">{row.symbol}</td>
                  <td className="py-1.5 pr-3 text-right">{usd(row.tvlUSD)}</td>
                  <td className="py-1.5 pr-3 text-right">{usd(row.volume24hUSD)}</td>
                  <td className="py-1.5 pr-3 text-right">{row.estLpFeeAprPct === null ? "unknown" : `${row.estLpFeeAprPct}%`}</td>
                  <td className="py-1.5 pr-3 text-right">{signed(row.change7dPct)}</td>
                  <td className="py-1.5 text-right">{signed(row.change30dPct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-[color:var(--m-text-secondary)]">{rank.basis} Markets under {usd(rank.minTvlUSD)} of liquidity and unlisted tokens are left out.</p>
    </>
  );
}
```

In `ToolParts.tsx`: add `import { parseRankOutput } from "./rankOutput";` and `import { RankTable } from "./RankTable";`; in `ReadToolPart`, after the `quote` line add `const rank = toolName.endsWith("_rank") && part.state === "output-available" && !failed ? parseRankOutput(part.output) : null;` and after the quote card's closing `)}` add `{rank && (<Card><RankTable rank={rank} /></Card>)}`. Touch nothing else in that file: the brand pass in the main checkout edits it too.

- [x] **Step 4: run, expect pass**; then `pnpm --filter @repo/web test typecheck lint`.
- [x] **Step 5: commit** — `git add apps/web/components/chat/rankOutput.ts apps/web/components/chat/rankOutput.test.ts apps/web/components/chat/RankTable.tsx apps/web/components/chat/ToolParts.tsx && git commit -m "feat(web): show a rank result as a table"`

---

### Task 6: the whole thing, and one live look

- [x] `pnpm typecheck && pnpm lint && pnpm test && pnpm build` at the repo root. All clean. (`packages/protocols` tests need the network.)
- [x] `pnpm e2e`. The 35 existing tests pass unchanged: the suite sets no `TYPESAFE_API_KEY`, so it proves the off path. There is no end-to-end test of the pre-run: the suite has no fake for Iter's gateway, and the chat integration tests in Task 4 stand in (spec §8).
- [x] One live call, by hand, never in CI: with `TYPESAFE_API_KEY` from the main checkout's `apps/web/.env.local`, run `readRequest` on "Where can I earn the highest APY providing liquidity?" and on "swap 50 USDC to WETH" from a scratch script outside the repo. Expect `provide_liquidity / highest_yield` over the gate, and `swap_specific`. Record model, confidences and milliseconds in this plan under "Checked live".
- [x] Scan what changed for `TODO`, `test.skip`, `.only`, leftover `console.log`, and for the API key's value.
- [x] Tick the boxes in this file, add "Closed on review" after the reviews, and update `docs/superpowers/STATUS.md`: a new branch row for `feat/plan-11-jev-router`, and under decisions for the owner: **Jev's cost is absorbed in the margin until its price is known** and **the router gate (0.9) rests on twelve prompts**.

## Checked
At `f85a97d`, from the repo root: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` all clean, no warnings. **936 unit tests** (wallet 248, db 30, ui 2, protocols 257 with the live-testnet address check, agent 54, web 345; 834 before this branch). Added code holds no `TODO`, `.skip`, `.only` or `console.log`, and neither API key's value appears in the branch diff.

**End to end: not clean on the machine it was last run on, and the evidence says that is the machine.** The suite sets no `TYPESAFE_API_KEY`, so it exercises the off path only. At `412b909` it passed **35 of 35 in 40 s**. At `f85a97d`, on the same laptop later the same day with load averages between 12 and 25 (other projects' dev servers, a browser and a chat client busy), three runs gave 32, 31 and 34 of 35 in 1.1 to 1.8 minutes. The failing tests changed from run to run; every failure was a page or the wallet frame not appearing inside a 5 s or 30 s wait, never a wrong value; none touches the rank, router or pre-run code. Two controlled checks: the one test that failed twice (`chat.spec.ts:56`) passed **3 of 3** alone with one worker at `f85a97d`; and the full suite at `63f7a60`, the commit BEFORE the fix wave, which had passed 35 of 35 that morning, failed **2 of 35** under the same load, the same chat test among them. **Then it was run in CI, which this branch adds (`.github/workflows/ci.yml`), and that settled it.** On an idle GitHub runner the first run gave 33 of 35, failing the same way as the laptop: the first visit to a route `next dev` had not compiled yet (the wallet frame in the run's first test; `/settings/permissions` inside a 5 s wait). So it was never load as such: the suite needs a fast machine for first page loads, and a 16-core laptop hid that until it was busy. With `retries: process.env.CI ? 2 : 0` the run at `f578f7a` is **green: 35 of 35, of which 30 passed first time and 5 passed on their first retry** (none needed a second); every first-attempt failure was a 5 s or 30 s wait on a cold route, in the wallet, permissions and reopen-a-chat flows, none in code this branch touches. The unit job is green there too, with Foundry installed for the address check (`verify-addresses: 30 addresses have code`). The retries make CI usable; they do not make those five tests good. Warming the routes once before the suite, or longer first-load waits, would.
## Checked live
One run by hand, 2026-09-20, the shipped `readRequest` against `jev-1.13.0` (never in CI):

| Message | Intent (confidence) | Measure (confidence) | ms | Pre-run |
|---|---|---|---|---|
| Where can I earn the highest APY providing liquidity? | provide_liquidity (1.00) | highest_yield (1.00) | 559 | yes |
| swap 50 USDC to WETH | swap_specific (1.00) | unspecified (1.00) | 590 | no |
| What's pumping this week? I want in. | buy_asset (0.88) | weekly_momentum (1.00) | 215 | no: under the gate |
| I have 500 USDC, what's the best asset to buy right now? | buy_asset (0.99) | unspecified (1.00) | 335 | no: no measure stated |
| 수익률이 가장 높은 풀에 유동성을 공급하고 싶어 | provide_liquidity (1.00) | highest_yield (1.00) | 195 | yes |

About 655 input and 150 output tokens a request (the spike's requests, which carried market data, were about 2,550 and 450).

## Closed on review
- The router built its abort signal outside its `try`, so "never throws" held only by accident. Moved inside; a test passes a bad signal.
- The no-leak test used one- and two-character canaries that passed by coincidence. Distinctive values now.
- The pre-run path showed the library's "An error occurred." when the model failed; it now says the app's sentence.
- `meta.router` was written only when a pre-run fired, so most Jev calls left no record. It is written whenever a reading was obtained.
- A reduced hold covers one call, and a pre-run turn is charged for two: no reader is used on such a turn.
- The prompt estimator made a pre-run turn cost about 2.8 times an ordinary one. The abandoned call is charged from the restarted call's measured input tokens instead (1.5 times).
- `rank` runs before the speculative call is given up, so a rank failure wastes nothing.
- The pump's error exit could write a second `start` after a switch. The pump is its own function now, with the rule on its final exit and seven unit tests.
- The rank parser's test sat where the suite did not look. It lives in `apps/web/lib/chat/`.
- The rank table was not tied to its measure and basis for a screen reader. It is, and header cells have a scope.
- **From the whole-branch review.** An unknown price change was read as 0, so `lowest_risk` ranked a market the gateway said nothing about as perfectly stable and rows showed unknown as 0%: both changes are `number | null` end to end now, such a market stays out of the three rankings that need the number, and the table says "unknown". A committed turn waited for a rank read it could no longer use before its stream could close: the read is raced against the commit. The two charges for one abandoned call are mutually exclusive in code (`stepCharges`), not by the SDK's ordering. `.env.example` and the README say that the key changes what a pre-run turn costs (about 1.5 times) and that the reader runs beside the model. The table's measure labels are typed from `RANK_MEASURES`, it says how many markets were looked at, `meta.router` is asserted on pre-run and discarded-reading turns, and one test holds the pumped path's streamed chunk types equal to the no-reader path's.

## Left for the owner
1. **Whether to charge the abandoned call at all.** It is not known whether the gateway bills a call aborted before its first token. Today it is charged from a measurement and recorded in `meta.router.speculative`; absorbing it instead is a one-line change.
2. **The router gate (0.9) rests on twelve prompts** and five live calls. It wants a labelled set.
3. **Jev's own cost is absorbed** in the margin until its price is known; its tokens are recorded.
4. **`budget.shouldStop` does not see the abandoned call's charge**, so a long tool loop on a pre-run turn may start one step it would have declined. The abort guard and the settlement cap keep the person's charge inside the hold; the operator may eat about one step. Fixing it means changing `Budget` in `packages/agent`.
5. **A turn that costs nothing records no `meta.router`**, because `settleHold` writes a ledger row only when something is charged (a pre-run turn stopped before its first step).
6. With a key set, **every metered turn goes through the new stream composition**, not only pre-run turns.
7. **Five end-to-end tests pass only on a retry in CI** (see "Checked"): each times out on its first visit to a route the dev server has not compiled. CI retries them and reports them as flaky. A global setup that visits the wallet frame, `/settings/permissions` and `/c/[id]` once before the suite would remove the cause.
8. **Reviewed and deferred, none of which can mischarge or mislead a person today:** a sanity cap on an absurd estimated APR; a streaming 64 KB cap in `router.ts` (it buffers the body first, bounded by the 1.5 s abort; `gateway.ts` `readCapped` is the pattern); `apps/web/lib/server/testHooks.test.ts` runs at 2.8 s of a 5 s timeout and flaked once under full-suite load; the comment in `speculation.ts` says the two charges are exclusive "by construction" when that holds for the natural ordering only.

## Not in this plan
Metering Jev's cost. A labelled prompt set to tune the gate. Jev for swap arguments or risk scoring. A `rank` read on MCP adapters. Router provenance shown in the interface (the metadata is there for it). An end-to-end test of the pre-run (needs a gateway fake in the e2e harness).
