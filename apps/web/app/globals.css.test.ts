import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type Rule = { selectors: string[]; body: string; reduced: boolean };

const REDUCED = /^@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)$/;
// The properties that start motion. Delays, durations and timings only tune a motion started elsewhere.
const STARTS = { animation: /(?:^|;)\s*animation(?:-name)?\s*:/, transition: /(?:^|;)\s*transition(?:-property)?\s*:/ };
const STOPS = { animation: /(?:^|;)\s*animation\s*:\s*none\s*(?:;|$)/, transition: /(?:^|;)\s*transition\s*:\s*none\s*(?:;|$)/ };

/** Splits a selector list on its top-level commas, so `:not(a, b)` stays whole, and collapses whitespace. */
function splitSelectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of list) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(current);
      current = "";
    } else current += ch;
  }
  out.push(current);
  return out.map((s) => s.trim().replace(/\s+/g, " ")).filter(Boolean);
}

/** Every style rule in the sheet, noting which sit inside the reduced-motion block. Keyframe steps are not rules. */
function parseRules(css: string, reduced = false): Rule[] {
  const rules: Rule[] = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf("{", i);
    if (open === -1) break;
    const prelude = css.slice(i, open).replace(/^[^{}]*;/, "").trim();
    let depth = 1;
    let close = open + 1;
    for (; close < css.length && depth > 0; close++) {
      if (css[close] === "{") depth++;
      if (css[close] === "}") depth--;
    }
    const body = css.slice(open + 1, close - 1);
    if (prelude.startsWith("@keyframes")) {
      // Keyframe steps describe the motion itself.
    } else if (prelude.startsWith("@")) {
      rules.push(...parseRules(body, reduced || REDUCED.test(prelude.replace(/\s+/g, " "))));
    } else {
      rules.push({ selectors: splitSelectors(prelude), body: body.trim(), reduced });
    }
    i = close;
  }
  return rules;
}

const css = readFileSync(new URL("./globals.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rules = parseRules(css);

describe("globals.css reduced motion", () => {
  it("finds the reduced-motion block and the animated classes", () => {
    expect(rules.some((rule) => rule.reduced)).toBe(true);
    expect(rules.filter((rule) => !rule.reduced && STARTS.animation.test(rule.body)).length).toBeGreaterThan(0);
  });

  it("stops every animation and transition it starts elsewhere", () => {
    const stopped = { animation: new Set<string>(), transition: new Set<string>() };
    for (const rule of rules.filter((r) => r.reduced))
      for (const kind of ["animation", "transition"] as const) if (STOPS[kind].test(rule.body)) rule.selectors.forEach((s) => stopped[kind].add(s));

    const missing: string[] = [];
    for (const rule of rules.filter((r) => !r.reduced))
      for (const kind of ["animation", "transition"] as const)
        if (STARTS[kind].test(rule.body)) for (const s of rule.selectors) if (!stopped[kind].has(s)) missing.push(`${s} (${kind}: none)`);

    expect(missing).toEqual([]);
  });
});
