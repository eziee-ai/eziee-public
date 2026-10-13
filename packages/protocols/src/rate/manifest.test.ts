import { describe, expect, it } from "vitest";
import { createRegistry } from "../registry";
import { RATE_DEPLOYMENTS } from "./generated/deployments";
import { rateManifest } from "./manifest";
import raw from "../../registry/rate/manifest.json";

describe("the vendored Rate manifest", () => {
  it("parses and registers without collisions", () => {
    expect(rateManifest.id).toBe("rate");
    expect(createRegistry([raw]).all()).toHaveLength(1);
  });

  it("serves Arc, RISE and Monad testnets, each with every contract the adapter uses", () => {
    expect(rateManifest.chains).toEqual([5042002, 11155931, 10143]);
    // A chain may deploy more than the adapter needs (RISE has a batch executor and a wrapped native token).
    for (const chainId of rateManifest.chains) expect(Object.keys(rateManifest.contracts[String(chainId)]!)).toEqual(expect.arrayContaining(["matchingEngine", "swapRouter", "bandPoolFactory", "positionManager"]));
  });

  it("keeps tokens out of the contract set", () => {
    for (const chainId of rateManifest.chains) {
      const contracts = new Set(Object.values(rateManifest.contracts[String(chainId)]!).map((c) => c.address.toLowerCase()));
      for (const token of rateManifest.tokens[String(chainId)]!) expect(contracts.has(token.address.toLowerCase())).toBe(false);
    }
  });

  it("takes every manifest address from the generated deployment data", () => {
    for (const chainId of rateManifest.chains) {
      const deployed = RATE_DEPLOYMENTS[String(chainId) as keyof typeof RATE_DEPLOYMENTS].contracts as Record<string, { address: string }>;
      for (const [key, contract] of Object.entries(rateManifest.contracts[String(chainId)]!)) expect(contract.address).toBe(deployed[key]!.address);
    }
  });

  it("vendors Monad's launchpad: the generator and LadderBuyer may be approved, and tUSD is listed", () => {
    const monad = rateManifest.contracts["10143"]!;
    expect(monad.assetGenerator?.role).toBe("router");
    expect(monad.ladderBuyer?.role).toBe("router");
    expect(rateManifest.tokens["10143"]!.map((t) => t.symbol)).toEqual(expect.arrayContaining(["tUSD", "USDC"]));
  });

  it("records Arc's USDC at 6 decimals, the ERC-20 view of an 18-decimal native balance", () => {
    const usdc = rateManifest.tokens["5042002"]!.find((t) => t.symbol === "USDC");
    expect(usdc?.decimals).toBe(6);
    expect(usdc?.trust).toBe("canonical");
  });
});
