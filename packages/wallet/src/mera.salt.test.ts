import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The PRF salt decides every user's address. Changing it orphans every wallet,
// so the literal is pinned by a test that reads the source text.
describe("PRF salt", () => {
  const source = readFileSync(fileURLToPath(new URL("./mera.ts", import.meta.url)), "utf8");

  it("is the fixed v1 literal", () => {
    expect(source).toContain('"wlt1.mera.v1.secp256k1.account\\0\\0"');
  });

  it("encodes to exactly 32 bytes", () => {
    expect(new TextEncoder().encode("wlt1.mera.v1.secp256k1.account\0\0").length).toBe(32);
  });
});
