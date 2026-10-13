import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Two wagmi snapshots in the lockfile mean two React contexts: every hook in
// @repo/wallet then throws "useConfig must be used within WagmiProvider" under the
// app's provider. It happened once, when an optional zod peer resolved to different
// versions per importer; the root pnpm.overrides pin is what prevents it.
describe("workspace dependency graph", () => {
  it("resolves exactly one wagmi instance", () => {
    const lock = readFileSync(fileURLToPath(new URL("../../../pnpm-lock.yaml", import.meta.url)), "utf8");
    const snapshots = new Set(lock.match(/^ {2}wagmi@[^\n]+:$/gm) ?? []);
    // One entry under `packages:` (bare version) and one under `snapshots:` (with peers).
    const withPeers = [...snapshots].filter((line) => line.includes("("));
    expect(withPeers).toHaveLength(1);
  });
});
