import { describe, expect, it, vi } from "vitest";
import { AURORA_BLOCKCHAIN, createAuroraIntents } from "./aurora";

const ALICE = "0x0000000000000000000000000000000000001001" as const;
const KEY = "secret-key-123";
const BASE_USDC = "0x0000000000000000000000000000000000000201";
const tokens = { asset_stats: [], tokens: [
  { assetId: "nep141:base-usdc.omft.near", decimals: 6, blockchain: "base", symbol: "USDC", price: 1, priceUpdatedAt: "2026-09-20T00:00:00Z", contractAddress: BASE_USDC },
  { assetId: "nep141:base.omft.near", decimals: 18, blockchain: "base", symbol: "ETH", price: 2000, priceUpdatedAt: "2026-09-20T00:00:00Z" },
  { assetId: "nep141:sol.omft.near", decimals: 9, blockchain: "sol", symbol: "SOL", price: 100, priceUpdatedAt: "2026-09-20T00:00:00Z" },
] };
const quoteBody = { timestamp: "t", signature: "s", quoteRequest: {}, quote: { timeEstimate: 45, deadline: "2026-09-21T00:00:00Z", depositAddress: "So1anaDepositAddr", amountIn: "1000000000", amountInFormatted: "1", amountInUsd: "100", minAmountIn: "1000000000", amountOut: "99000000", amountOutFormatted: "99", amountOutUsd: "99", minAmountOut: "98000000" } };

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, headers: { get: () => null }, body: null, text: async () => JSON.stringify(body) });
function setup(reply: (url: string, init?: { method?: string; body?: string }) => unknown) {
  const fetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => reply(url, init) as never);
  return { fetch, route: createAuroraIntents({ apiKey: KEY, fetch }) };
}
const BASE = 8453;

describe("the Aurora Intents funding route", () => {
  it("knows which app networks it can deliver to, and that is none of the testnets", () => {
    const { route } = setup(() => json({}));
    expect(route.supportsDestination(BASE)).toBe(true);
    expect(route.supportsDestination(5042002)).toBe(false);
    expect(route.supportsDestination(11155931)).toBe(false);
    expect(AURORA_BLOCKCHAIN[1]).toBe("eth");
  });

  it("is off entirely without a key", () => {
    expect(createAuroraIntents({ apiKey: undefined }).supportsDestination(BASE)).toBe(false);
  });

  it("lists source assets, cleaned, with the key in the path and nowhere else", async () => {
    const { route, fetch } = setup(() => json(tokens));
    const sources = await route.sources();
    expect(sources.map((s) => s.symbol)).toEqual(["USDC", "ETH", "SOL"]);
    expect(fetch.mock.calls[0]![0]).toBe(`https://intents-api.aurora.dev/api/tokens/${KEY}`);
  });

  it("FUNDING IN: quotes an exact input from another chain to the SESSION's address on the app network, refunding to the address the person gave", async () => {
    const { route, fetch } = setup((url) => json(url.includes("/tokens/") ? tokens : quoteBody));
    const quote = await route.quote({ direction: "in", chainId: BASE, appAsset: BASE_USDC, otherAssetId: "nep141:sol.omft.near", amount: "1000000000", otherAddress: "So1anaRefundAddr", slippageBps: 100, account: ALICE });
    expect(quote).toMatchObject({ depositAddress: "So1anaDepositAddr", amountOut: "99000000", minAmountOut: "98000000", timeEstimate: 45 });
    const sent = JSON.parse(fetch.mock.calls[1]![1]!.body!) as Record<string, unknown>;
    expect(sent).toMatchObject({ dry: false, swapType: "EXACT_INPUT", depositType: "ORIGIN_CHAIN", originAsset: "nep141:sol.omft.near", destinationAsset: "nep141:base-usdc.omft.near", amount: "1000000000", slippageTolerance: 100, recipient: ALICE, recipientType: "DESTINATION_CHAIN", refundTo: "So1anaRefundAddr", refundType: "ORIGIN_CHAIN" });
    expect(sent).not.toHaveProperty("appFees");
  });

  it("FUNDING OUT: the refund always comes back to the session's address on the app network", async () => {
    const { route, fetch } = setup((url) => json(url.includes("/tokens/") ? tokens : quoteBody));
    await route.quote({ direction: "out", chainId: BASE, appAsset: "native", otherAssetId: "nep141:sol.omft.near", amount: "5", otherAddress: "So1anaRecipient", slippageBps: 50, account: ALICE });
    expect(JSON.parse(fetch.mock.calls[1]![1]!.body!)).toMatchObject({ originAsset: "nep141:base.omft.near", destinationAsset: "nep141:sol.omft.near", recipient: "So1anaRecipient", refundTo: ALICE });
  });

  it.each([
    ["an app asset the route does not list on that network", { appAsset: "0x0000000000000000000000000000000000000999" }, /not supported/],
    ["an asset id it does not list", { otherAssetId: "nep141:made-up" }, /not supported/],
    ["a network it cannot deliver to", { chainId: 5042002 }, /not supported/],
    ["an asset on the very network being funded, which is a swap and not a transfer between chains", { otherAssetId: "nep141:base.omft.near" }, /different network/],
    ["a zero amount", { amount: "0" }, /amount/],
    ["absurd slippage", { slippageBps: 5001 }, /slippage/],
    ["an address with markup in it", { otherAddress: "<script>" }, /address/],
  ])("refuses %s before asking for a quote", async (_name, patch, message) => {
    const { route, fetch } = setup((url) => json(url.includes("/tokens/") ? tokens : quoteBody));
    await expect(route.quote({ direction: "in", chainId: BASE, appAsset: BASE_USDC, otherAssetId: "nep141:sol.omft.near", amount: "1000", otherAddress: "So1anaRefundAddr", slippageBps: 100, account: ALICE, ...patch })).rejects.toThrow(message);
    expect(fetch.mock.calls.filter(([url]) => String(url).includes("/quote/"))).toHaveLength(0);
  });

  it("refuses a quote with no deposit address, or whose output is below what it says is the minimum", async () => {
    const noAddress = setup((url) => json(url.includes("/tokens/") ? tokens : { ...quoteBody, quote: { ...quoteBody.quote, depositAddress: undefined } }));
    await expect(noAddress.route.quote({ direction: "in", chainId: BASE, appAsset: BASE_USDC, otherAssetId: "nep141:sol.omft.near", amount: "1000", otherAddress: "So1anaRefundAddr", slippageBps: 100, account: ALICE })).rejects.toThrow();
  });

  it("reports status, and never repeats the key or the upstream's words when something fails", async () => {
    const ok = setup(() => json({ status: "PROCESSING" }));
    expect(await ok.route.status({ depositAddress: "So1anaDepositAddr" })).toEqual({ status: "PROCESSING" });
    expect(ok.fetch.mock.calls[0]![0]).toBe(`https://intents-api.aurora.dev/api/status/${KEY}?depositAddress=So1anaDepositAddr`);

    for (const broken of [setup(() => json({ message: `bad key ${KEY}`, statusCode: 500 }, 500)), setup(() => Promise.reject(new Error(`connect failed https://intents-api.aurora.dev/api/status/${KEY}`))), setup(() => json({ status: "INVENTED" }))]) {
      const failure = (await broken.route.status({ depositAddress: "x" }).catch((error: unknown) => error)) as Error;
      expect(failure).toBeInstanceOf(Error);
      expect(failure.message).not.toContain(KEY);
    }
  });

  it("submits a deposit's transaction hash", async () => {
    const { route, fetch } = setup(() => json({ status: "KNOWN_DEPOSIT_TX" }));
    await route.submit({ txHash: "0xabc", depositAddress: "So1anaDepositAddr" });
    expect(fetch.mock.calls[0]![0]).toBe(`https://intents-api.aurora.dev/api/deposit/submit/${KEY}`);
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body!)).toEqual({ txHash: "0xabc", depositAddress: "So1anaDepositAddr" });
  });
});
