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

/** A price change is `null` when the source did not report one: unknown, which is not the same as unmoved. */
export interface RankMarket { id: string; symbol: string; listed: boolean; base: { address: string; symbol: string }; quote: { address: string; symbol: string }; tvlUSD: number; volume24hUSD: number; takerFee: number | null; change7dPct: number | null; change30dPct: number | null }
export interface RankRow { rank: number; id: string; symbol: string; base: { address: string; symbol: string }; quote: { address: string; symbol: string }; tvlUSD: number; volume24hUSD: number; feeBps: number | null; estLpFeeAprPct: number | null; change7dPct: number | null; change30dPct: number | null }
export interface RankResult { measure: RankMeasure; basis: string; minTvlUSD: number; considered: number; eligible: number; none: boolean; note?: string; rows: RankRow[] }

function round(value: number, places: number): number;
function round(value: number | null, places: number): number | null;
function round(value: number | null, places: number): number | null {
  return value === null ? null : Math.round(value * 10 ** places) / 10 ** places;
}

/** An ESTIMATE. It assumes liquidity providers earn the taker fee on 24h volume; `null` when the fee is unknown. */
function estimatedAprPct(market: RankMarket): number | null {
  if (market.takerFee === null || market.tvlUSD <= 0) return null;
  return (market.volume24hUSD * market.takerFee * DAYS_PER_YEAR * 100) / market.tvlUSD;
}

const MEASURES: Record<RankMeasure, { basis: string; score: (market: RankMarket) => number | null }> = {
  highest_yield: { basis: "Estimated LP fee APR: 24h volume x taker fee x 365 / TVL. An estimate from one day of trading, not a promise.", score: estimatedAprPct },
  deepest_liquidity: { basis: "Total value locked in the market, in USD.", score: (m) => m.tvlUSD },
  most_traded: { basis: "Trading volume over the last 24 hours, in USD.", score: (m) => m.volume24hUSD },
  // A measure made of a price change scores `null` when that change is unknown: an unknown must never be read as
  // "the price did not move", which on `lowest_risk` would let the market with the least known about it lead.
  weekly_momentum: { basis: "Price change of the base token over the last 7 days.", score: (m) => m.change7dPct },
  monthly_dip: { basis: "Largest price fall of the base token over the last 30 days.", score: (m) => (m.change30dPct === null ? null : -m.change30dPct) },
  lowest_risk: { basis: "Depth discounted by how far the price moved in 30 days: TVL / (1 + |30-day change %|).", score: (m) => (m.change30dPct === null ? null : m.tvlUSD / (1 + Math.abs(m.change30dPct))) },
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
