import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = fileURLToPath(new URL("../app/globals.css", import.meta.url));

/**
 * Tailwind only generates the classes it finds in the files it is pointed at, and a `@source` that points
 * nowhere fails silently: the build is green and whatever lives there renders unstyled. pnpm does not hoist
 * packages to the repo root, which is exactly how the markdown renderer's path went wrong once.
 */
describe("globals.css @source paths", () => {
  const sources = Array.from(readFileSync(css, "utf8").matchAll(/^@source\s+"([^"]+)";/gm), (match) => match[1]!);

  it("has some", () => expect(sources.length).toBeGreaterThan(0));

  it.each(sources)("%s points at files that exist", (source) => {
    const [folder, pattern] = source.includes("*") ? [dirname(source), source.slice(source.lastIndexOf("/") + 1)] : [source, null];
    const absolute = resolve(dirname(css), folder);
    expect(existsSync(absolute), `${absolute} does not exist`).toBe(true);
    if (pattern) {
      const extension = pattern.replace("*", "");
      expect(readdirSync(absolute).some((name) => name.endsWith(extension))).toBe(true);
    }
  });
});
