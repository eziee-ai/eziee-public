import { decodeFunctionData, encodeFunctionData, erc20Abi, getAddress, type Address, type Hex, type PublicClient } from "viem";
import { describe, expect, it, vi } from "vitest";
import { createRegistry } from "../registry";
import type { TxRequest } from "../types";
import { BandSwapRouterABI, MatchingEngineABI } from "./abis";
import { decodeRateSwap } from "./decodeSwap";
import { isUnguardedRateMarketOrder } from "./decodeLiquidity";
import type { FetchLike } from "./gateway";
import { createRateAdapter } from "./index";
import { rateManifest } from "./manifest";
import raw from "../../registry/rate/manifest.json";

const ARC = 5042002;
const ALICE = "0x0000000000000000000000000000000000001001" as Address;
const MALLORY = "0x0000000000000000000000000000000000001002" as Address;
const POOL = "0x0000000000000000000000000000000000005001" as Address;
const FAKE_POOL = "0x0000000000000000000000000000000000005002" as Address;
const LAUNCHED = "0x0000000000000000000000000000000000002001" as Address;
const contracts = rateManifest.contracts[String(ARC)]!;
const ROUTER = contracts.swapRouter!.address;
const ENGINE = contracts.matchingEngine!.address;
const FACTORY = contracts.bandPoolFactory!.address;
const [USDC, EURC] = rateManifest.tokens[String(ARC)]!.map((t) => t.address) as [Address, Address];

/** A chain with one genuine pool (base EURC, quote USDC) and configurable allowances. */
function chain(options: { allowance?: bigint; poolBase?: Address; poolQuote?: Address; factoryPool?: Address; decimals?: Record<string, number>; /** No pool at all: only the order book, (base, quote). */ bookOnly?: [Address, Address] } = {}) {
  const base = options.poolBase ?? EURC;
  const quote = options.poolQuote ?? USDC;
  const readContract = vi.fn(async ({ address, functionName, args }: { address: Address; functionName: string; args?: readonly unknown[] }) => {
    const at = address.toLowerCase();
    if (functionName === "base") return base;
    if (functionName === "quote") return quote;
    if (functionName === "getPool" && at === FACTORY.toLowerCase()) {
      const [a, b] = args as [Address, Address];
      if (options.bookOnly) return "0x0000000000000000000000000000000000000000";
      return a.toLowerCase() === base.toLowerCase() && b.toLowerCase() === quote.toLowerCase() ? (options.factoryPool ?? POOL) : "0x0000000000000000000000000000000000000000";
    }
    if (functionName === "getPair" && at === ENGINE.toLowerCase()) {
      const [a, b] = args as [Address, Address];
      const [bookBase, bookQuote] = options.bookOnly ?? [base, quote];
      return a.toLowerCase() === bookBase.toLowerCase() && b.toLowerCase() === bookQuote.toLowerCase() ? "0x0000000000000000000000000000000000007001" : "0x0000000000000000000000000000000000000000";
    }
    if (functionName === "allowance") return options.allowance ?? 0n;
    if (functionName === "decimals") return options.decimals?.[at] ?? (at === LAUNCHED.toLowerCase() ? 18 : 6);
    throw new Error(`unexpected read ${functionName} on ${address}`);
  });
  const call = vi.fn(async (request: { to: Address }) => ({ data: (request.to ? "0x" : "0x") as Hex }));
  return { client: { readContract, call } as unknown as PublicClient, readContract, call };
}

const swapData = (pool: Address, amountIn: bigint, quoteToBase: boolean, recipient: Address, minOut: bigint) => encodeFunctionData({ abi: BandSwapRouterABI, functionName: "swap", args: [pool, amountIn, quoteToBase, recipient, minOut] });
const tx = (to: Address, data: Hex, value = 0n): TxRequest => ({ chainId: ARC, to, data, value });

describe("decodeRateSwap — a swap names a pool, so the pool must be proven genuine", () => {
  it("decodes USDC → EURC through a factory pool", async () => {
    const { client } = chain();
    expect(await decodeRateSwap(tx(ROUTER, swapData(POOL, 50_000_000n, true, ALICE, 49_000_000n)), ALICE, client)).toEqual({
      protocol: "rate", action: "swap", chainId: ARC, contract: "swapRouter", spends: true,
      spend: [{ token: USDC, amount: 50_000_000n, listed: true }],
      receive: { token: EURC, minAmount: 49_000_000n, listed: true },
      recipient: ALICE, unlisted: false,
    });
  });

  it("reads the direction flag: base → quote spends the base token", async () => {
    const { client } = chain();
    expect(await decodeRateSwap(tx(ROUTER, swapData(POOL, 7n, false, ALICE, 1n)), ALICE, client)).toMatchObject({ spend: [{ token: EURC, amount: 7n }], receive: { token: USDC } });
  });

  it("flags a launched coin as unlisted rather than vouching for it", async () => {
    const { client } = chain({ poolBase: LAUNCHED });
    expect(await decodeRateSwap(tx(ROUTER, swapData(POOL, 1n, true, ALICE, 1n)), ALICE, client)).toMatchObject({ unlisted: true, receive: { token: LAUNCHED, listed: false } });
  });

  it.each([
    ["a pool the factory does not know (an attacker's contract posing as one)", () => ({ t: tx(ROUTER, swapData(FAKE_POOL, 1n, true, ALICE, 1n)), c: chain() })],
    ["a recipient that is not the signer", () => ({ t: tx(ROUTER, swapData(POOL, 1n, true, MALLORY, 1n)), c: chain() })],
    ["native value attached", () => ({ t: tx(ROUTER, swapData(POOL, 1n, true, ALICE, 1n), 1n), c: chain() })],
    ["a zero amount", () => ({ t: tx(ROUTER, swapData(POOL, 0n, true, ALICE, 1n)), c: chain() })],
    ["a call to something other than the router", () => ({ t: tx(ENGINE, swapData(POOL, 1n, true, ALICE, 1n)), c: chain() })],
    ["bytes appended to the calldata", () => ({ t: tx(ROUTER, `${swapData(POOL, 1n, true, ALICE, 1n)}00` as Hex), c: chain() })],
    ["a chain Rate is not on", () => ({ t: { ...tx(ROUTER, swapData(POOL, 1n, true, ALICE, 1n)), chainId: 1 }, c: chain() })],
  ])("returns null for %s", async (_name, make) => {
    const { t, c } = make();
    expect(await decodeRateSwap(t, ALICE, c.client)).toBeNull();
  });

  it("returns null when the pool lies about its own tokens, because the factory then disagrees", async () => {
    // The fake pool claims (EURC, USDC); the factory's entry for that pair is the REAL pool.
    const { client } = chain();
    expect(await decodeRateSwap(tx(ROUTER, swapData(FAKE_POOL, 1n, true, ALICE, 1n)), ALICE, client)).toBeNull();
  });

  it("returns null, never throws, when the chain cannot be read", async () => {
    const client = { readContract: vi.fn(async () => { throw new Error("rpc down"); }) } as unknown as PublicClient;
    await expect(decodeRateSwap(tx(ROUTER, swapData(POOL, 1n, true, ALICE, 1n)), ALICE, client)).resolves.toBeNull();
  });
});

describe("Rate's order actions decode from the manifest alone", () => {
  const registry = createRegistry([raw]);
  const order = (fn: "limitBuy" | "limitSell", recipient: Address, base: Address = EURC) => encodeFunctionData({ abi: MatchingEngineABI, functionName: fn, args: [{ base, quote: USDC, price: 101_235_000n, amount: 2_000_000n, isMaker: true, n: 20, recipient }] });

  it("a limit buy spends the QUOTE token", () => {
    expect(registry.decode(tx(ENGINE, order("limitBuy", ALICE)), ALICE)).toMatchObject({ action: "placeOrder", spends: true, spend: [{ token: USDC, amount: 2_000_000n, listed: true }], receive: { token: EURC }, recipient: ALICE, unlisted: false });
  });

  it("a limit sell spends the BASE token", () => {
    expect(registry.decode(tx(ENGINE, order("limitSell", ALICE)), ALICE)).toMatchObject({ action: "placeOrder", spend: [{ token: EURC, amount: 2_000_000n }], receive: { token: USDC } });
  });

  it("refuses an order whose proceeds go to someone else", () => {
    expect(registry.decode(tx(ENGINE, order("limitBuy", MALLORY)), ALICE)).toBeNull();
  });

  it("flags an order for a launched coin as unlisted", () => {
    expect(registry.decode(tx(ENGINE, order("limitBuy", ALICE, LAUNCHED)), ALICE)).toMatchObject({ unlisted: true });
  });

  it("a cancel spends nothing", () => {
    const data = encodeFunctionData({ abi: MatchingEngineABI, functionName: "cancelOrder", args: [EURC, USDC, true, 1] });
    expect(registry.decode(tx(ENGINE, data), ALICE)).toMatchObject({ action: "cancelOrder", spends: false, spend: [] });
  });

  it("recognises an exact approval to the router and to the engine, and to nothing else", () => {
    const approve = (spender: Address) => tx(USDC, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, 5n] }));
    expect(registry.decodeApproval(approve(ROUTER))?.spenderKey).toBe("swapRouter");
    expect(registry.decodeApproval(approve(ENGINE))?.spenderKey).toBe("matchingEngine");
    expect(registry.decodeApproval(approve(FACTORY))).toBeNull();
  });
});

describe("building Rate actions", () => {
  const route = (estimatedOut: number, leftoverIn = 0) => ({ available: true, path: [USDC, EURC], amountIn: 50, estimatedOut, leftoverIn, priceImpactPct: 0.1, hops: [{ pair: "EURC/USDC", side: "buyBase", mktPrice: 1, avgPrice: 1 }] });
  const gateway = (body: unknown): FetchLike => async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
  const ctx = (c: ReturnType<typeof chain>) => ({ chainId: ARC, account: ALICE, client: c.client });

  it("swap: an exact approval, then the router call with minOut from the fresh quote and the slippage limit", async () => {
    const c = chain({ allowance: 0n });
    const rate = createRateAdapter({ fetch: gateway(route(49.5)) });
    const intent = rate.actions.swap!.intent.parse({ tokenIn: USDC, tokenOut: EURC, amountIn: "50", maxSlippageBps: 50 });
    const txs = await rate.actions.swap!.build(intent, ctx(c));

    expect(txs).toHaveLength(2);
    expect(txs[0]!.to).toBe(USDC);
    expect(decodeFunctionData({ abi: erc20Abi, data: txs[0]!.data }).args).toEqual([ROUTER, 50_000_000n]);
    expect(txs[1]!.to).toBe(ROUTER);
    // 49.5 EURC less 0.50% = 49.2525
    expect(decodeFunctionData({ abi: BandSwapRouterABI, data: txs[1]!.data }).args).toEqual([POOL, 50_000_000n, true, ALICE, 49_252_500n]);
    // What was built decodes back to what was asked: the round trip the guideline requires.
    expect(await decodeRateSwap(txs[1]!, ALICE, c.client)).toMatchObject({ spend: [{ token: USDC, amount: 50_000_000n }], receive: { token: EURC, minAmount: 49_252_500n } });
  });

  it.each([
    ["buys when tokenOut is the book's base: marketBuy, the amount in the quote paid", USDC, EURC, "marketBuy", { base: EURC, quote: USDC }, { spend: USDC, receive: EURC }],
    ["sells when tokenIn is the book's base: marketSell, the amount in the base sold", EURC, USDC, "marketSell", { base: EURC, quote: USDC }, { spend: EURC, receive: USDC }],
  ] as const)("swap with no pool, only a book: %s", async (_name, tokenIn, tokenOut, fn, pair, sides) => {
    const c = chain({ bookOnly: [EURC, USDC] });
    const rate = createRateAdapter({ fetch: gateway(route(49.5)) });
    const txs = await rate.actions.swap!.build(rate.actions.swap!.intent.parse({ tokenIn, tokenOut, amountIn: "50", maxSlippageBps: 50 }), ctx(c));
    expect(txs).toHaveLength(2);
    expect(decodeFunctionData({ abi: erc20Abi, data: txs[0]!.data }).args).toEqual([ENGINE, 50_000_000n]);
    expect(txs[1]!.to).toBe(ENGINE);
    const call = decodeFunctionData({ abi: MatchingEngineABI, data: txs[1]!.data });
    expect(call.functionName).toBe(fn);
    // 0.50% is 500,000 engine units (1e8 is 100%).
    expect(call.args).toEqual([{ ...pair, amount: 50_000_000n, isMaker: false, n: 20, recipient: ALICE, slippageLimit: 500_000 }]);
    expect(isUnguardedRateMarketOrder(txs[1]!)).toBe(false);
    // The wallet describes it as the swap it is, from the manifest.
    // It always asks: its card cannot promise a minimum received, so no rule may cover it.
    expect(createRegistry([raw]).decode(txs[1]!, ALICE)).toMatchObject({ action: "swap", contract: "matchingEngine", alwaysAsk: true, spend: [{ token: sides.spend, amount: 50_000_000n }], receive: { token: sides.receive }, recipient: ALICE });
  });

  it("swap with no pool and no book: INSUFFICIENT_LIQUIDITY", async () => {
    const rate = createRateAdapter({ fetch: gateway(route(49.5)) });
    const intent = rate.actions.swap!.intent.parse({ tokenIn: USDC, tokenOut: LAUNCHED, amountIn: "50", maxSlippageBps: 50 });
    await expect(rate.actions.swap!.build(intent, ctx(chain({ bookOnly: [EURC, USDC] })))).rejects.toMatchObject({ code: "INSUFFICIENT_LIQUIDITY" });
  });

  it.each([
    ["a zero slippage limit, which the engine reads as the venue default", { slippageLimit: 0 }],
    ["a limit wider than the card may hide (5%)", { slippageLimit: 5_000_001 }],
    ["a maker order, which would rest on the book unseen", { isMaker: true }],
    ["no matches allowed", { n: 0 }],
    ["more matches than the builder allows", { n: 21 }],
  ] as const)("a market order with %s is not described as a swap", (_name, patch) => {
    const data = encodeFunctionData({ abi: MatchingEngineABI, functionName: "marketBuy", args: [{ base: EURC, quote: USDC, amount: 1n, isMaker: false, n: 20, recipient: ALICE, slippageLimit: 500_000, ...patch }] });
    expect(isUnguardedRateMarketOrder(tx(ENGINE, data))).toBe(true);
  });

  it("swap: skips the approval when the allowance already covers it", async () => {
    const rate = createRateAdapter({ fetch: gateway(route(49.5)) });
    const txs = await rate.actions.swap!.build(rate.actions.swap!.intent.parse({ tokenIn: USDC, tokenOut: EURC, amountIn: "50", maxSlippageBps: 50 }), ctx(chain({ allowance: 50_000_000n })));
    expect(txs).toHaveLength(1);
  });

  it.each([
    ["QUOTE_MOVED when the fresh quote is below what the user was shown, beyond the slippage limit", { expectedOut: "50" }, route(49.5), "QUOTE_MOVED"],
    ["INSUFFICIENT_LIQUIDITY when the route cannot take the whole amount", {}, route(40, 10), "INSUFFICIENT_LIQUIDITY"],
    ["INSUFFICIENT_LIQUIDITY when there is no market", {}, { available: false, code: "no-route" }, "INSUFFICIENT_LIQUIDITY"],
  ])("swap: %s", async (_name, extra, body, code) => {
    const rate = createRateAdapter({ fetch: gateway(body) });
    const intent = rate.actions.swap!.intent.parse({ tokenIn: USDC, tokenOut: EURC, amountIn: "50", maxSlippageBps: 50, ...extra });
    await expect(rate.actions.swap!.build(intent, ctx(chain()))).rejects.toMatchObject({ code });
  });

  it("swap: refuses slippage above 50% and amounts with more decimals than the token has", async () => {
    const rate = createRateAdapter({ fetch: gateway(route(49.5)) });
    expect(rate.actions.swap!.intent.safeParse({ tokenIn: USDC, tokenOut: EURC, amountIn: "50", maxSlippageBps: 5001 }).success).toBe(false);
    const intent = rate.actions.swap!.intent.parse({ tokenIn: USDC, tokenOut: EURC, amountIn: "0.0000001", maxSlippageBps: 50 });
    await expect(rate.actions.swap!.build(intent, ctx(chain()))).rejects.toMatchObject({ code: "INVALID_INTENT" });
  });

  it("placeOrder: a buy approves and escrows the QUOTE amount, at a 1e8-scaled price", async () => {
    const rate = createRateAdapter();
    const intent = rate.actions.placeOrder!.intent.parse({ side: "buy", base: EURC, quote: USDC, price: "1.01235", amount: "2" });
    const txs = await rate.actions.placeOrder!.build(intent, ctx(chain()));
    expect(decodeFunctionData({ abi: erc20Abi, data: txs[0]!.data }).args).toEqual([ENGINE, 2_000_000n]);
    const call = decodeFunctionData({ abi: MatchingEngineABI, data: txs[1]!.data });
    expect(call.functionName).toBe("limitBuy");
    expect(call.args).toEqual([{ base: EURC, quote: USDC, price: 101_235_000n, amount: 2_000_000n, isMaker: true, n: 20, recipient: ALICE }]);
    expect(createRegistry([raw]).decode(txs[1]!, ALICE)).toMatchObject({ action: "placeOrder", spend: [{ token: USDC, amount: 2_000_000n }] });
  });

  it("placeOrder: a sell escrows the BASE amount in the base token's own decimals", async () => {
    const rate = createRateAdapter();
    const intent = rate.actions.placeOrder!.intent.parse({ side: "sell", base: LAUNCHED, quote: USDC, price: "2", amount: "1.5" });
    const txs = await rate.actions.placeOrder!.build(intent, ctx(chain()));
    expect(txs[0]!.to).toBe(getAddress(LAUNCHED));
    expect(decodeFunctionData({ abi: MatchingEngineABI, data: txs[1]!.data }).args).toEqual([{ base: LAUNCHED, quote: USDC, price: 200_000_000n, amount: 1_500_000_000_000_000_000n, isMaker: true, n: 20, recipient: ALICE }]);
  });

  it("cancelOrder: one call, nothing approved, nothing spent", async () => {
    const rate = createRateAdapter();
    const txs = await rate.actions.cancelOrder!.build(rate.actions.cancelOrder!.intent.parse({ base: EURC, quote: USDC, side: "buy", orderId: 1 }), ctx(chain()));
    expect(txs).toHaveLength(1);
    expect(decodeFunctionData({ abi: MatchingEngineABI, data: txs[0]!.data }).args).toEqual([EURC, USDC, true, 1]);
  });

  it("simulate: reports a revert with its reason, and defers a call that only fails for want of the approval before it", async () => {
    const rate = createRateAdapter({ fetch: gateway(route(49.5)) });
    const c = chain({ allowance: 0n });
    const txs = await rate.actions.swap!.build(rate.actions.swap!.intent.parse({ tokenIn: USDC, tokenOut: EURC, amountIn: "50", maxSlippageBps: 50 }), ctx(c));
    c.call.mockImplementation(async ({ to }: { to: Address }) => {
      if (to === ROUTER) throw new Error("execution reverted: ERC20: insufficient allowance");
      return { data: "0x" as Hex };
    });
    expect(await rate.actions.swap!.simulate(txs, ctx(c))).toEqual({ ok: true, deferred: [1] });
    expect(await rate.actions.swap!.simulate([txs[1]!], ctx(c))).toMatchObject({ ok: false, reason: expect.stringContaining("insufficient allowance") });
  });
});
