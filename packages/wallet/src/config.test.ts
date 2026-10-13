import { beforeEach, describe, expect, it, vi } from "vitest";

describe("wallet config", () => {
  beforeEach(() => vi.resetModules());

  it("throws before configureWallet is called", async () => {
    const { walletConfig } = await import("./config");
    expect(() => walletConfig()).toThrow("Wallet is not configured");
  });

  it("returns chains in the order given and finds one by id", async () => {
    const { configureWallet, walletChains, chainById } = await import("./config");
    const { TEST_CHAIN_A, TEST_CHAIN_B } = await import("./testing/fixture");
    configureWallet({ chains: [TEST_CHAIN_A, TEST_CHAIN_B], brand: "Test" });
    expect(walletChains().map((c) => c.id)).toEqual([TEST_CHAIN_A.id, TEST_CHAIN_B.id]);
    expect(chainById(TEST_CHAIN_B.id).name).toBe(TEST_CHAIN_B.name);
  });

  it("throws for a chain that is not configured", async () => {
    const { configureWallet, chainById } = await import("./config");
    const { TEST_CHAIN_A } = await import("./testing/fixture");
    configureWallet({ chains: [TEST_CHAIN_A], brand: "Test" });
    expect(() => chainById(1)).toThrow("Chain 1 is not configured");
  });
});
