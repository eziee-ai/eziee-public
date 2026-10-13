import { defineChain, encodeFunctionData, parseAbi, type Address, type PublicClient } from "viem";
import { describe, expect, it, vi } from "vitest";
import { parseManifest } from "../manifest";
import { ADDR, FIXTURE_CHAIN_ID, fixtureManifest } from "../testing/fixture";
import { createProxiedMcpAdapter } from "./proxied";

const manifest = parseManifest(fixtureManifest());
const chain = defineChain({ id: FIXTURE_CHAIN_ID, name: "Fixture", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["http://localhost"] } } });
const SWAP = parseAbi(["function swapExactIn(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address to, uint256 deadline)"]);
const ALICE = ADDR.alice as Address;
const ctx = { chainId: FIXTURE_CHAIN_ID, account: ALICE, client: {} as PublicClient };
const swap = (to: Address) => ({ chainId: FIXTURE_CHAIN_ID, to: ADDR.router, data: encodeFunctionData({ abi: SWAP, functionName: "swapExactIn", args: [ADDR.usdc, ADDR.weth, 5n, 1n, to, 4_000_000_000n] }), value: "0" });
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

describe("createProxiedMcpAdapter — the browser's side of an MCP protocol", () => {
  it("offers exactly the manifest's actions, asks OUR server to build, and never sends an account (the server uses the session's)", async () => {
    const fetch = vi.fn(async () => ok({ txs: [swap(ALICE)], expiresAt: Math.floor(Date.now() / 1000) + 60 }));
    const adapter = createProxiedMcpAdapter({ manifest, chains: [chain], fetch });
    expect(Object.keys(adapter.actions).sort()).toEqual(["cancelOrder", "swap", "swapNative"]);
    expect(adapter.reads).toEqual({});

    const txs = await adapter.actions.swap!.build({ amountIn: "5" }, ctx);
    expect(txs).toEqual([{ chainId: FIXTURE_CHAIN_ID, to: ADDR.router, data: swap(ALICE).data, value: 0n }]);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, { method: string; body: string }];
    expect(url).toBe("/api/protocols/fixture/build");
    expect(JSON.parse(init.body)).toEqual({ action: "swap", chainId: FIXTURE_CHAIN_ID, intent: { amountIn: "5" } });
  });

  it("checks what comes back against its OWN bundled manifest: a compromised server of ours cannot pay someone else either", async () => {
    const adapter = createProxiedMcpAdapter({ manifest, chains: [chain], fetch: async () => ok({ txs: [swap(ADDR.mallory)], expiresAt: Math.floor(Date.now() / 1000) + 60 }) });
    await expect(adapter.actions.swap!.build({}, ctx)).rejects.toThrow(/not the fixture swap action/);
  });

  it("carries our server's error code and message through", async () => {
    const adapter = createProxiedMcpAdapter({ manifest, chains: [chain], fetch: async () => ({ ok: false, status: 422, json: async () => ({ error: { code: "QUOTE_MOVED", message: "The price moved" } }) }) });
    await expect(adapter.actions.swap!.build({}, ctx)).rejects.toMatchObject({ code: "QUOTE_MOVED", message: "The price moved" });
  });

  it("is unavailable, with no detail, when our server cannot be reached or answers nonsense", async () => {
    const down = createProxiedMcpAdapter({ manifest, chains: [chain], fetch: async () => Promise.reject(new Error("offline")) });
    await expect(down.actions.swap!.build({}, ctx)).rejects.toMatchObject({ code: "TEMPORARILY_UNAVAILABLE" });
    const odd = createProxiedMcpAdapter({ manifest, chains: [chain], fetch: async () => ({ ok: false, status: 500, json: async () => ({ error: { code: "MADE_UP", message: "x" } }) }) });
    await expect(odd.actions.swap!.build({}, ctx)).rejects.toMatchObject({ code: "TEMPORARILY_UNAVAILABLE" });
  });
});
