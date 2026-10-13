import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseManifest } from "./schema";

/**
 * The manifest a joining protocol will copy is the one in the guideline. It once used keys the schema refuses, and
 * a team's first contact with the platform was a parse error caused by our own document. It is parsed here.
 */
describe("the guideline's example manifest", () => {
  const guideline = readFileSync(fileURLToPath(new URL("../../../../docs/protocol-integration/mcp-guideline.md", import.meta.url)), "utf8");
  const example = /<!-- manifest-example:start -->\s*```json\n([\s\S]*?)\n```\s*<!-- manifest-example:end -->/.exec(guideline)?.[1];

  it("is there", () => expect(example).toBeTruthy());

  it("parses, with every feature it shows", () => {
    const manifest = parseManifest(JSON.parse(example!));
    expect(Object.keys(manifest.actions)).toEqual(["swap", "closePosition"]);
    expect(manifest.actions.closePosition!.alwaysAsk).toBe(true);
  });
});
