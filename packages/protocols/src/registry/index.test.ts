import { encodeFunctionData, parseAbi } from "viem";
import { describe, expect, it } from "vitest";
import { ProtocolError } from "../errors";
import { ADDR, FIXTURE_CHAIN_ID, fixtureManifest } from "../testing/fixture";
import { createRegistry } from "./index";

type Mutable = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function second(mutate: (m: Mutable) => void = () => {}): Mutable {
  const m = fixtureManifest() as Mutable;
  m.id = "second";
  m.name = "Second DEX";
  m.contracts[FIXTURE_CHAIN_ID] = { router: { ...m.contracts[FIXTURE_CHAIN_ID].router, address: "0x0000000000000000000000000000000000000301" } };
  delete m.actions.cancelOrder;
  mutate(m);
  return m;
}

describe("createRegistry", () => {
  it("indexes manifests by id and by chain", () => {
    const registry = createRegistry([fixtureManifest(), second()]);
    expect(registry.all().map((m) => m.id)).toEqual(["fixture", "second"]);
    expect(registry.get("second")?.name).toBe("Second DEX");
    expect(registry.get("missing")).toBeUndefined();
    expect(registry.forChain(FIXTURE_CHAIN_ID).map((m) => m.id)).toEqual(["fixture", "second"]);
    expect(registry.forChain(1)).toEqual([]);
  });

  it("maps every registered contract on a chain to its protocol, key and role", () => {
    const contracts = createRegistry([fixtureManifest(), second()]).contracts(FIXTURE_CHAIN_ID);
    expect(contracts.get(ADDR.router.toLowerCase())).toEqual({ protocol: "fixture", key: "router", role: "router" });
    expect(contracts.get("0x0000000000000000000000000000000000000301")).toEqual({ protocol: "second", key: "router", role: "router" });
    expect(contracts.size).toBe(3);
    expect(createRegistry([fixtureManifest()]).contracts(1).size).toBe(0);
  });

  it("decodes through whichever protocol owns the target", () => {
    const registry = createRegistry([fixtureManifest(), second()]);
    const data = encodeFunctionData({ abi: parseAbi(["function cancel(uint256 orderId)"]), functionName: "cancel", args: [1n] });
    expect(registry.decode({ chainId: FIXTURE_CHAIN_ID, to: ADDR.book, data, value: 0n }, ADDR.alice)).toMatchObject({ protocol: "fixture", action: "cancelOrder" });
    expect(registry.decode({ chainId: FIXTURE_CHAIN_ID, to: ADDR.stranger, data, value: 0n }, ADDR.alice)).toBeNull();
  });

  it.each([
    ["an invalid manifest", () => [{ id: "nope" }], /manifestVersion|Required/],
    ["a duplicate protocol id", () => [fixtureManifest(), fixtureManifest()], /duplicate protocol id "fixture"/],
    ["one contract address claimed by two protocols", () => [fixtureManifest(), second((m) => (m.contracts[FIXTURE_CHAIN_ID].router.address = ADDR.router))], /claimed by both/],
    ["a contract address that is also a listed token", () => [fixtureManifest(), second((m) => (m.contracts[FIXTURE_CHAIN_ID].router.address = ADDR.usdc))], /token/],
  ])("refuses %s", (_name, build, message) => {
    let error: unknown;
    try {
      createRegistry(build());
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).code).toBe("INVALID_MANIFEST");
    expect((error as ProtocolError).message).toMatch(message);
  });
});
