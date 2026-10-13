/** Code point ranges removed from untrusted text: controls, soft hyphen, zero-width and invisible fillers, line separators, bidi overrides and isolates. */
const STRIPPED_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [0xad, 0xad],
  [0x115f, 0x1160],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x2069],
  [0x2800, 0x2800],
  [0x3164, 0x3164],
  [0xfeff, 0xfeff],
];

function isStripped(codePoint: number): boolean {
  return STRIPPED_RANGES.some(([low, high]) => codePoint >= low && codePoint <= high);
}

/**
 * Text from outside (a gateway, an MCP server, a token's own name), made inert before anything else sees it: invisible and
 * direction-override characters out, markup and link syntax out (a token name has
 * no business containing `<`, `[`, a backtick or `://`), whitespace collapsed,
 * length capped. This text reaches a language model and a web page; it is data.
 */
export function clean(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const visible = Array.from(value, (ch) => (isStripped(ch.codePointAt(0) ?? 0) ? " " : ch)).join("");
  const inert = visible.replace(/:\/\//g, " ").replace(/[<>[\](){}`]/g, " ");
  const flat = inert.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
