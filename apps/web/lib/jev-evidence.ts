import fixture from "../../../docs/research/2026-09-20-jev-spike/harness/results-fixture-1789879155371.json";
import live from "../../../docs/research/2026-09-20-jev-spike/harness/results-rise-1789879280971.json";

// Match build-share.mjs: upper-middle observation for an even number of samples.
function median(values: number[]) {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
}

const labels: Record<string, string> = {
  lp_apy: "Highest APY to LP", buy_open: "Best asset to buy", lp_deep: "Deepest pool to LP",
  buy_momentum: "What’s pumping", buy_volume: "Most traded token", buy_dip: "Buy the monthly dip",
  lp_safe: "Low-risk yield", lp_apy_ko: "Highest APY (Korean)", swap_exact: "Exact swap",
  orders: "My open orders", vague: "Vague message", inject: "Hearsay about a bad token",
};

// Aggregate on the server; only the chart values and prompts reach the client.
export function getJevEvidence() {
  const rankingRuns = [fixture, live].flatMap((run) => run.rows.filter((row) => row.truth).flatMap((row) => row.jev.map((result) => ({ result, truth: row.truth }))));
  return {
    runsPerPrompt: fixture.runs,
    jevMedianMs: median(fixture.rows.flatMap((row) => row.jev.map((result) => result.ms))),
    llmMedianMs: median(fixture.rows.flatMap((row) => row.llm.map((result) => result.ms))),
    rankedCorrect: rankingRuns.filter(({ result, truth }) => result.b2Pick === truth).length,
    directCorrect: rankingRuns.filter(({ result, truth }) => result.b1Pick === truth).length,
    rankingTotal: rankingRuns.length,
    rows: fixture.rows.map((row) => ({
      id: row.id,
      label: labels[row.id] ?? row.id,
      prompt: row.text,
      jevMs: median(row.jev.map((result) => result.ms)),
      llmMs: median(row.llm.map((result) => result.ms)),
    })),
  };
}

export type JevEvidenceData = ReturnType<typeof getJevEvidence>;
