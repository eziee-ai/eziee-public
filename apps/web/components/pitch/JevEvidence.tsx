"use client";

import { useState, type CSSProperties } from "react";
import { ArrowUpRight } from "lucide-react";
import type { JevEvidenceData } from "@/lib/jev-evidence";
import s from "./evidence.module.css";

const seconds = (ms: number) => `${(ms / 1000).toFixed(ms < 1000 ? 2 : 1)} s`;

export function JevEvidence({ data }: { data: JevEvidenceData }) {
  const [selected, setSelected] = useState("buy_momentum");
  const [expanded, setExpanded] = useState(false);
  const maxMs = Math.ceil(Math.max(...data.rows.flatMap((row) => [row.jevMs, row.llmMs])) / 2000) * 2000;
  const featured = data.rows.find((row) => row.id === "buy_momentum") ?? data.rows[0]!;
  const speedMultiple = Math.round(data.llmMedianMs / data.jevMedianMs);
  const renderRow = (row: JevEvidenceData["rows"][number]) => <button key={row.id} type="button" className={s.row} aria-pressed={selected === row.id} aria-expanded={selected === row.id} onClick={() => setSelected(row.id)} aria-label={`${row.label}. Jev typed reading ${seconds(row.jevMs)}; language model full answer ${seconds(row.llmMs)}. ${selected === row.id ? row.prompt : "Show exact prompt."}`}>
    <span className={s.label}>{row.label}</span>
    <span className={s.tracks} aria-hidden="true">
      <span className={s.track}><span className={`${s.bar} ${s.jevBar}`} style={{ "--bar-width": `${row.jevMs / maxMs * 100}%` } as CSSProperties}><b>{seconds(row.jevMs)}</b></span></span>
      <span className={s.track}><span className={`${s.bar} ${s.llmBar}`} style={{ "--bar-width": `${row.llmMs / maxMs * 100}%` } as CSSProperties}><b>{seconds(row.llmMs)}</b></span></span>
    </span>
    {selected === row.id && <span className={s.rowPrompt}>“{row.prompt}”</span>}
  </button>;
  const renderFeatured = <div className={s.featuredCard} role="group" aria-label={`${featured.prompt}. eziee with Jev ${seconds(featured.jevMs)}; typical language model agent ${seconds(featured.llmMs)}`}>
    <div className={s.compareTitle}>Same intent. Two ways to get an answer.</div>
    <div className={s.featuredBars}>
      <div className={s.featuredRow}><span className={s.featuredLabel}><em className={s.accentWord}>eziee</em> + Jev<small>typed market reading</small></span><span className={s.featuredTrack}><span className={`${s.bar} ${s.jevBar}`} style={{ "--bar-width": `${featured.jevMs / maxMs * 100}%` } as CSSProperties}><b>{seconds(featured.jevMs)}</b></span></span></div>
      <div className={s.featuredRow}><span className={s.featuredLabel}>Typical LLM agent<small>full written answer</small></span><span className={s.featuredTrack}><span className={`${s.bar} ${s.llmBar}`} style={{ "--bar-width": `${featured.llmMs / maxMs * 100}%` } as CSSProperties}><b>{seconds(featured.llmMs)}</b></span></span></div>
    </div>
    <strong className={s.compareClaim}>eziee reaches a usable market signal about {speedMultiple}× sooner.</strong>
    <p>“{featured.prompt}”</p>
  </div>;

  return <div className={s.evidence}>
    {/* The one representative prompt is the first proof under the section heading; the full list stays behind the toggle. */}
    {renderFeatured}
    <div className={s.summary}>
      <div><strong>{seconds(data.jevMedianMs)}</strong><span><em className={s.accentWord}>eziee</em> + Jev · typed reading</span></div>
      <div><strong>{seconds(data.llmMedianMs)}</strong><span>Typical LLM agent · full answer</span></div>
      <div><strong>{data.rankedCorrect}<small>/{data.rankingTotal}</small></strong><span>Correct rankings · Jev + code</span></div>
    </div>
    {/* Method note: these are different tasks, not an equal-work speed benchmark. */}
    <p className={s.method}>“Eziee uses Jev — about {seconds(data.jevMedianMs)} to read a market signal, so you can ask more questions before you act.”</p>
    {/* The report measured baseline spend, but did not look up Jev's price. */}
    <p className={s.method}>Cost check: the language-model baseline was $0.0084 per fixture question and $0.0276 on live data. Jev pricing was not included in this run.</p>

    <button type="button" className={s.expandButton} aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? "Hide prompt timings" : `Show all ${data.rows.length} prompt timings`} <span>{expanded ? "↑" : "↓"}</span></button>
    {expanded && <>
    <div className={s.legend}><span><i className={s.jevKey} />Jev · typed reading</span><span><i className={s.llmKey} />Language model · full answer</span></div>
    <div className={s.chart} role="group" aria-label="Median response times by prompt, in seconds">
      {data.rows.map(renderRow)}
      <div className={s.axis} aria-hidden="true"><span>0 s</span><span>{maxMs / 2000} s</span><span>{maxMs / 1000} s</span></div>
    </div>

    <div className={s.finding}><h3>The model reads.<br />Code does the ranking.</h3><div><p>When Jev identified the measure and code ranked the markets, the result matched the expected market <strong>{data.rankedCorrect}/{data.rankingTotal}</strong> times. When Jev compared the numbers itself: <strong>{data.directCorrect}/{data.rankingTotal}</strong>.</p><p>Ask for “best” without a measure, and the desk asks what you mean. The language model stays to explain what the numbers leave out.</p></div></div>
    <div className={s.source}><p>Measured 20 Sep 2026. Ranking results combine fixture and testnet runs with a defined expected answer. A small experiment, not a broad benchmark or transaction-speed measurement.</p><a href="/pitch/jev-report.html" target="_blank" rel="noreferrer">Read the full report <ArrowUpRight /></a></div>
    </>}
  </div>;
}
