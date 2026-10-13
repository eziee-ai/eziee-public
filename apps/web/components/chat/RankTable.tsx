import { useId } from "react";
import type { RankMeasure } from "@repo/protocols/types";
import type { RankView } from "@/lib/chat/rankOutput";

/** Typed by the measure list itself, so a measure added there cannot be left without a label here. */
const MEASURE_LABEL: Record<RankMeasure, string> = { highest_yield: "Highest estimated yield", deepest_liquidity: "Deepest liquidity", most_traded: "Most traded, 24h", weekly_momentum: "Largest 7-day rise", monthly_dip: "Largest 30-day fall", lowest_risk: "Deep and quiet" };
const usd = (value: number) => `$${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
/** The read only sees the gateway's first page of markets, so the table says how many it looked at. */
const consideredSentence = (considered: number | undefined) => (considered === undefined ? "" : ` Looked at the ${considered} busiest market${considered === 1 ? "" : "s"}.`);
/** A price change the read did not have is shown as unknown, never as 0%: this desk shows numbers it has. */
const signed = (value: number | null) => (value === null ? "unknown" : `${value > 0 ? "+" : ""}${value}%`);

export function RankTable({ rank }: { rank: RankView }) {
  const measureId = useId();
  const basisId = useId();
  return (
    <>
      <div className="flex items-center justify-between gap-3">
        {/* A saved chat may hold a measure this build no longer has a label for; it is shown as it was saved. */}
        <span id={measureId} className="text-sm font-semibold">{MEASURE_LABEL[rank.measure as RankMeasure] ?? rank.measure}</span>
        <span className="text-xs text-[color:var(--m-text-secondary)]">Ranked by the numbers, not advice</span>
      </div>
      {rank.none ? (
        <p className="text-[13px] text-[color:var(--m-text-secondary)]">{rank.note ?? "Nothing qualifies right now."}</p>
      ) : (
        <div className="overflow-x-auto">
          <table aria-labelledby={measureId} aria-describedby={basisId} className="w-full min-w-[520px] border-collapse text-[13px]">
            <thead>
              <tr className="text-left text-xs text-[color:var(--m-text-secondary)]">
                <th scope="col" className="py-1.5 pr-3 font-normal">#</th>
                <th scope="col" className="py-1.5 pr-3 font-normal">Market</th>
                <th scope="col" className="py-1.5 pr-3 text-right font-normal">TVL</th>
                <th scope="col" className="py-1.5 pr-3 text-right font-normal">Volume 24h</th>
                <th scope="col" className="py-1.5 pr-3 text-right font-normal">APR, estimated</th>
                <th scope="col" className="py-1.5 pr-3 text-right font-normal">7d</th>
                <th scope="col" className="py-1.5 text-right font-normal">30d</th>
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
      <p id={basisId} className="text-xs text-[color:var(--m-text-secondary)]">{rank.basis} Markets under {usd(rank.minTvlUSD)} of liquidity and unlisted tokens are left out.{consideredSentence(rank.considered)}</p>
    </>
  );
}
