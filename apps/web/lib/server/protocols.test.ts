import { encodeFunctionData, parseAbi, type Address, type PublicClient } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseManifest } from "@repo/protocols/manifest";
import type { McpCaller } from "@repo/protocols/mcp";
import { ADDR, FIXTURE_CHAIN_ID, fixtureManifest } from "@repo/protocols/testing/fixture";
import { createProtocolSource, handleBuild, mcpEndpoint } from "./protocols";

const manifest = parseManifest(fixtureManifest());
const SWAP = parseAbi(["function swapExactIn(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address to, uint256 deadline)"]);
const ALICE = ADDR.alice as Address;
const swapFor = (account: Address) => ({ chainId: FIXTURE_CHAIN_ID, to: ADDR.router, data: encodeFunctionData({ abi: SWAP, functionName: "swapExactIn", args: [ADDR.usdc, ADDR.weth, 5n, 1n, account, 4_000_000_000n] }), value: "0" });

const honest: McpCaller = {
  listTools: async () => [{ name: "fixture.build.swap", inputSchema: { type: "object", properties: { intent: { type: "object", properties: { amountIn: { type: "string" }, maxSlippageBps: { type: "integer" } }, required: ["amountIn", "maxSlippageBps"] } } } }, { name: "fixture.read.quote", description: "A quote" }],
  callTool: async (_name, args) => ({ structuredContent: { txs: [swapFor((args as { account: Address }).account)], expiresAt: Math.floor(Date.now() / 1000) + 60 } }),
};
const chains = [{ id: FIXTURE_CHAIN_ID, name: "Fixture" }] as never;
const clientFor = () => ({}) as PublicClient;

afterEach(() => vi.unstubAllEnvs());

describe("mcpEndpoint — where a verified protocol's server is, from deployment configuration", () => {
  it("reads MCP_<ID>_URL and MCP_<ID>_KEY, upper-cased with dashes as underscores", () => {
    vi.stubEnv("MCP_SOME_DEX_URL", "https://mcp.some-dex.example/mcp");
    vi.stubEnv("MCP_SOME_DEX_KEY", "k");
    expect(mcpEndpoint("some-dex")).toEqual({ url: "https://mcp.some-dex.example/mcp", apiKey: "k" });
  });

  it("is null when no address is configured: the protocol is then simply not offered", () => {
    expect(mcpEndpoint("fixture")).toBeNull();
  });
});

describe("createProtocolSource", () => {
  it("offers first-party adapters plus every verified protocol whose server answers", async () => {
    const source = createProtocolSource({ firstParty: [], verified: [manifest], chains, callerFor: () => honest });
    const adapters = await source.adapters();
    expect(adapters.map((a) => a.id)).toEqual(["fixture"]);
    expect(Object.keys(adapters[0]!.actions)).toEqual(["swap"]);
  });

  it("leaves out a protocol with no server configured or an unreachable one, without failing the others", async () => {
    const down: McpCaller = { listTools: async () => Promise.reject(new Error("down")), callTool: async () => ({}) };
    expect(await createProtocolSource({ firstParty: [], verified: [manifest], chains, callerFor: () => null }).adapters()).toEqual([]);
    expect(await createProtocolSource({ firstParty: [], verified: [manifest], chains, callerFor: () => down }).adapters()).toEqual([]);
  });

  it("after a failure asks again within seconds, not minutes: a two-second blip must not hide a protocol for five", async () => {
    let up = false;
    let now = 0;
    const listTools = vi.fn(async () => (up ? honest.listTools() : Promise.reject(new Error("down"))));
    const source = createProtocolSource({ firstParty: [], verified: [manifest], chains, callerFor: () => ({ ...honest, listTools }), now: () => now });
    expect(await source.adapters()).toEqual([]);
    now = 5_000;
    expect(await source.adapters()).toEqual([]); // still inside the short failure window: not asked again
    expect(listTools).toHaveBeenCalledTimes(1);
    up = true;
    now = 20_000;
    expect((await source.adapters()).map((a) => a.id)).toEqual(["fixture"]);
  });

  it("asks once when several requests arrive together on a cold start", async () => {
    const listTools = vi.fn(honest.listTools);
    const source = createProtocolSource({ firstParty: [], verified: [manifest], chains, callerFor: () => ({ ...honest, listTools }) });
    await Promise.all([source.adapters(), source.adapters(), source.adapters()]);
    expect(listTools).toHaveBeenCalledTimes(1);
  });

  it("asks a server for its tools once per few minutes, not once per message", async () => {
    const listTools = vi.fn(honest.listTools);
    let now = 0;
    const source = createProtocolSource({ firstParty: [], verified: [manifest], chains, callerFor: () => ({ ...honest, listTools }), now: () => now });
    await source.adapters();
    now = 4 * 60_000;
    await source.adapters();
    expect(listTools).toHaveBeenCalledTimes(1);
    now = 6 * 60_000;
    await source.adapters();
    expect(listTools).toHaveBeenCalledTimes(2);
  });
});

describe("handleBuild — the browser asks our server to ask theirs", () => {
  const source = createProtocolSource({ firstParty: [], verified: [manifest], chains, callerFor: () => honest });
  const build = (body: unknown, address: Address = ALICE) => handleBuild({ source, protocolId: "fixture", address, body, clientFor });

  it("builds for the SESSION's address, whatever the body says", async () => {
    const response = await build({ action: "swap", chainId: FIXTURE_CHAIN_ID, intent: { amountIn: "5" }, account: ADDR.mallory });
    expect(response.status).toBe(200);
    const json = (await response.json()) as { txs: Array<{ data: string; value: string }>; expiresAt: number };
    expect(json.txs).toEqual([swapFor(ALICE)]);
    expect(json.expiresAt).toBeGreaterThan(Date.now() / 1000);
  });

  it("passes on the protocol's own expiry when it is sooner than ours, and never a later one", async () => {
    const at = (expiresAt: number): McpCaller => ({ ...honest, callTool: async (_n, args) => ({ structuredContent: { txs: [swapFor((args as { account: Address }).account)], expiresAt } }) });
    const ask = async (caller: McpCaller) => ((await (await handleBuild({ source: createProtocolSource({ firstParty: [], verified: [manifest], chains, callerFor: () => caller, now: () => 1_000_000_000_000 }), protocolId: "fixture", address: ALICE, body: { action: "swap", chainId: FIXTURE_CHAIN_ID, intent: { amountIn: "5", maxSlippageBps: 50 } }, clientFor, now: () => 1_000_000_000_000 })).json()) as { expiresAt: number }).expiresAt;
    expect(await ask(at(1_000_000_005))).toBe(1_000_000_005);
    expect(await ask(at(1_000_009_999))).toBe(1_000_000_060);
  });

  it.each([
    ["an unknown protocol", () => handleBuild({ source, protocolId: "ghost", address: ALICE, body: { action: "swap", chainId: FIXTURE_CHAIN_ID, intent: {} }, clientFor }), 404, "UNKNOWN_PROTOCOL"],
    ["an action the protocol does not have", () => build({ action: "rugPull", chainId: FIXTURE_CHAIN_ID, intent: {} }), 404, "UNKNOWN_ACTION"],
    ["a malformed body", () => build({ action: 7 }), 400, "INVALID_REQUEST"],
    ["a network this app does not serve", () => handleBuild({ source, protocolId: "fixture", address: ALICE, body: { action: "swap", chainId: 1, intent: {} }, clientFor: () => null }), 400, "UNSUPPORTED_CHAIN"],
  ])("refuses %s", async (_name, run, status, code) => {
    const response = await run();
    expect(response.status).toBe(status);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(code);
  });

  it("answers a protocol's own refusal as 422 with its code, and anything unexpected as unavailable with no detail", async () => {
    const refusing: McpCaller = { ...honest, callTool: async () => ({ isError: true, structuredContent: { code: "AMOUNT_TOO_SMALL", message: "too small" } }) };
    const one = await handleBuild({ source: createProtocolSource({ firstParty: [], verified: [manifest], chains, callerFor: () => refusing }), protocolId: "fixture", address: ALICE, body: { action: "swap", chainId: FIXTURE_CHAIN_ID, intent: {} }, clientFor });
    expect(one.status).toBe(422);
    expect(await one.json()).toMatchObject({ error: { code: "AMOUNT_TOO_SMALL", message: "too small" } });

    const broken: McpCaller = { ...honest, callTool: async () => Promise.reject(new Error("secret internals")) };
    const two = await handleBuild({ source: createProtocolSource({ firstParty: [], verified: [manifest], chains, callerFor: () => broken }), protocolId: "fixture", address: ALICE, body: { action: "swap", chainId: FIXTURE_CHAIN_ID, intent: {} }, clientFor });
    expect(two.status).toBe(422);
    const text = JSON.stringify(await two.json());
    expect(text).toContain("TEMPORARILY_UNAVAILABLE");
    expect(text).not.toContain("secret internals");
  });
});
