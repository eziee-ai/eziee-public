import { describe, expect, it } from "vitest";

describe("providers module", () => {
  it("configures the wallet before building the wagmi config", async () => {
    const { wagmiConfig } = await import("./providers");
    expect(wagmiConfig.chains.map((c) => c.id)).toEqual([5042002, 11155931, 10143]);
    expect(wagmiConfig.connectors.map((c) => c.id)).toContain("mera");
  });
});
