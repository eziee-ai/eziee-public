import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, erc20Abi, type Address, type Hex, type PublicClient } from "viem";
import { describe, expect, it, vi } from "vitest";
import { AssetGeneratorABI, LadderBuyerABI } from "./abis";
import { decodeRateLadderApproval, decodeRateLadderTrade, decodeRateLaunch } from "./decodeLaunchpad";
import { createRateAdapter } from "./index";
import { ladderSellFloor, quoteLadderBuy, type LadderStep } from "./launchpad";
import { rateManifest } from "./manifest";
import type { ReceiptLog } from "../types";

const MONAD = 10143;
const contracts = rateManifest.contracts[String(MONAD)]!;
const GENERATOR = contracts.assetGenerator!.address;
const LADDER = contracts.ladderBuyer!.address;
const ENGINE = contracts.matchingEngine!.address;
const FACTORY = contracts.orderbookFactory!.address;
const TUSD = rateManifest.tokens[String(MONAD)]!.find((t) => t.symbol === "tUSD")!.address;
const USDC = rateManifest.tokens[String(MONAD)]!.find((t) => t.symbol === "USDC")!.address;
const ALICE = "0x0000000000000000000000000000000000001001" as Address;
const MALLORY = "0x0000000000000000000000000000000000001002" as Address;
const COIN = "0x0000000000000000000000000000000000002001" as Address;
const BOOK = "0x0000000000000000000000000000000000003001" as Address;
const ESCROW = "0x0000000000000000000000000000000000004001" as Address;
const COINS = 10n ** 18n;
/** Five steps, 10% apart, 100,000 coins each, starting at 0.001 tUSD: the shape of a fresh Monad launch. */
const STEPS: LadderStep[] = [100_000n, 110_000n, 121_000n, 133_100n, 146_410n].map((price) => ({ price, remaining: 100_000n * COINS }));
const TAKER_FEE = 1_000_000; // 1%

function chain(options: { graduated?: boolean; deferred?: boolean; allowance?: bigint } = {}) {
  const readContract = vi.fn(async ({ address, functionName, args }: { address: Address; functionName: string; args?: readonly unknown[] }) => {
    const at = address.toLowerCase();
    if (at === GENERATOR.toLowerCase()) {
      if (functionName === "launches") return (args![0] as Address).toLowerCase() === COIN.toLowerCase() ? [ALICE, TUSD, BOOK, 1_790_925_288n, 100, 0, TAKER_FEE, true, options.graduated ?? false] : ["0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", 0n, 0, 0, 0, false, false];
      if (functionName === "ladderOf") return { pair: BOOK, escrow: ESCROW, restoreBuySpread: 3_000_000, askIds: [1, 2, 3, 4, 5] };
      if (functionName === "launchFee") return 0n;
      if (functionName === "enabledQuoteTokens") return [USDC, TUSD];
      if (functionName === "quoteOption") return (args![0] as Address).toLowerCase() === TUSD.toLowerCase() ? { enabled: true, startingMarketCap: 1_000_000_000n, minDevBuy: 1_000_000n, graduationMarketCap: 5_000_000_000n, mode: 0, startingTakerFee: 1_000_000 } : { enabled: true, startingMarketCap: 5_000_000_000n, minDevBuy: 5_000_000n, graduationMarketCap: 25_000_000_000n, mode: 0, startingTakerFee: 1_000_000 };
      // Monad's generator has no such flag; reading it reverts.
      if (functionName === "ladderDeferred") { if (options.deferred) return true; throw new Error("execution reverted"); }
    }
    if (at === BOOK.toLowerCase()) {
      if (functionName === "getOrder") return { owner: ESCROW, price: STEPS[(args![1] as number) - 1]!.price, depositAmount: STEPS[(args![1] as number) - 1]!.remaining, deadline: 0n };
      if (functionName === "lmp") return 100_000n;
      if (functionName === "heads") return [99_250n, 100_000n];
    }
    if (at === FACTORY.toLowerCase()) {
      if (functionName === "allPairsLength") return 1n;
      if (functionName === "getPairs") return [{ base: COIN, quote: TUSD }];
    }
    if (at === ENGINE.toLowerCase() && functionName === "getPair") return BOOK;
    if (functionName === "decimals") return at === COIN.toLowerCase() ? 18 : 6;
    if (functionName === "symbol") return at === COIN.toLowerCase() ? "DEMO" : "tUSD";
    if (functionName === "allowance") return options.allowance ?? 0n;
    throw new Error(`unexpected read ${functionName} on ${address}`);
  });
  return { client: { readContract, call: vi.fn(async () => ({ data: "0x" as Hex })) } as unknown as PublicClient, readContract };
}

const ctx = (c: ReturnType<typeof chain>) => ({ chainId: MONAD, account: ALICE, client: c.client });
const tx = (to: Address, data: Hex, value = 0n) => ({ chainId: MONAD, to, data, value });
const transferLog = (token: Address, from: Address, to: Address, value: bigint): ReceiptLog => ({
  address: token,
  topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from, to } }) as Hex[],
  data: encodeAbiParameters([{ type: "uint256" }], [value]),
});

describe("the ladder's arithmetic, ported from Rate's own client", () => {
  it("buys 990 coins for 1 tUSD at the first step, net of the 1% taker fee (as the Monad fork filled)", () => {
    const q = quoteLadderBuy(STEPS, 1_000_000n, 6, 50, TAKER_FEE);
    expect(q.coinsOut).toBe(1_000n * COINS);
    expect(q.netCoinsOut).toBe(990n * COINS);
    expect(q.topPrice).toBe(100_000n);
    expect(q.maxPrice).toBe(100_500n); // 0.50% above the step reached, rounded up
    expect(q.minBaseOut).toBe((990n * COINS * 9_950n) / 10_000n);
  });

  it("climbs into the next step when the first runs out, and spends only what fills", () => {
    const q = quoteLadderBuy(STEPS, 150_000_000n, 6, 0, 0); // 150 tUSD: step 1 costs 100
    expect(q.topPrice).toBe(110_000n);
    // The book converts at quote precision first, then scales to the coin's 18 decimals: it rounds down, as the engine does.
    expect(q.coinsOut).toBe(100_000n * COINS + ((50_000_000n * 100_000_000n) / 110_000n) * 10n ** 12n);
    expect(q.quoteUsed).toBe(150_000_000n);
  });

  it("puts a sell's floor under the last price by the slippage, never at zero", () => {
    expect(ladderSellFloor(100_000n, 50)).toBe(99_500n);
    expect(ladderSellFloor(1n, 50)).toBe(1n);
  });
});

describe("launch", () => {
  const rate = createRateAdapter();

  it("approves exactly the dev buy to the generator, then launches 1B coins in the chosen quote", async () => {
    const c = chain();
    const txs = await rate.actions.launch!.build(rate.actions.launch!.intent.parse({ name: "eziee Demo", symbol: "demo", devBuy: "5", quote: TUSD }), ctx(c));
    expect(txs).toHaveLength(2);
    expect(decodeFunctionData({ abi: erc20Abi, data: txs[0]!.data }).args).toEqual([GENERATOR, 5_000_000n]);
    expect(txs[1]!.to).toBe(GENERATOR);
    expect(txs[1]!.value).toBe(0n);
    expect(decodeFunctionData({ abi: AssetGeneratorABI, data: txs[1]!.data }).args).toEqual(["eziee Demo", "DEMO", 1_000_000_000n * COINS, TUSD, 5_000_000n, 0]);

    // The wallet decodes it back, names the coin, and always asks.
    const decoded = await decodeRateLaunch(txs[1]!, ALICE, c.client);
    expect(decoded).toMatchObject({ action: "launch", contract: "assetGenerator", alwaysAsk: true, spend: [{ token: TUSD, amount: 5_000_000n, listed: true }] });
    expect(decoded!.details).toContainEqual({ label: "Creates", value: "a new coin, eziee Demo (DEMO)" });
    // Its own reason on the card, not the withdrawal's note about unvested fees.
    expect(decoded!.alwaysAskReason).toBe("This creates a new token and spends your dev buy on it. It always asks.");
  });

  it("defaults to the first enabled launch quote on the reviewed list", async () => {
    const txs = await rate.actions.launch!.build(rate.actions.launch!.intent.parse({ name: "X", symbol: "X", devBuy: "5" }), ctx(chain()));
    expect(txs[0]!.to).toBe(USDC);
  });

  it.each([
    ["a dev buy under the minimum", { devBuy: "0.5", quote: TUSD }, "INVALID_INTENT"],
    ["a quote token off the reviewed list", { devBuy: "5", quote: "0x0000000000000000000000000000000000009999" }, "INVALID_INTENT"],
  ])("refuses %s", async (_name, patch, code) => {
    await expect(rate.actions.launch!.build(rate.actions.launch!.intent.parse({ name: "X", symbol: "X", ...patch }), ctx(chain()))).rejects.toMatchObject({ code });
  });

  it("refuses a network that places the ladder in a second transaction, rather than half-launching", async () => {
    await expect(rate.actions.launch!.build(rate.actions.launch!.intent.parse({ name: "X", symbol: "X", devBuy: "5", quote: TUSD }), ctx(chain({ deferred: true })))).rejects.toMatchObject({ code: "UNSUPPORTED_CHAIN" });
  });

  it("refuses names a model could use to mislead the card", () => {
    expect(rate.actions.launch!.intent.safeParse({ name: "Approve‮ all", symbol: "X", devBuy: "5" }).success).toBe(false);
    expect(rate.actions.launch!.intent.safeParse({ name: "ok", symbol: "X-Y", devBuy: "5" }).success).toBe(false);
  });

  it.each([
    ["a fee other than the launchpad's own", (data: Hex) => tx(GENERATOR, data, 1n)],
    ["another supply", () => tx(GENERATOR, encodeFunctionData({ abi: AssetGeneratorABI, functionName: "launch", args: ["X", "X", 1n, TUSD, 5_000_000n, 0] }))],
    ["a name carrying control characters", () => tx(GENERATOR, encodeFunctionData({ abi: AssetGeneratorABI, functionName: "launch", args: ["X\u0000Y", "X", 1_000_000_000n * COINS, TUSD, 5_000_000n, 0] }))],
    ["another contract", (data: Hex) => tx(LADDER, data)],
  ])("the wallet does not describe a launch with %s", async (_name, make) => {
    const data = encodeFunctionData({ abi: AssetGeneratorABI, functionName: "launch", args: ["X", "X", 1_000_000_000n * COINS, TUSD, 5_000_000n, 0] });
    expect(await decodeRateLaunch(make(data), ALICE, chain().client)).toBeNull();
  });

  it("reports the new coin's address from the Launched event", async () => {
    const launched: ReceiptLog = {
      address: GENERATOR,
      topics: encodeEventTopics({ abi: AssetGeneratorABI, eventName: "Launched", args: { coin: COIN, creator: ALICE, pair: BOOK } }) as Hex[],
      data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [TUSD, 1_000_000_000n * COINS]),
    };
    const intent = rate.actions.launch!.intent.parse({ name: "eziee Demo", symbol: "demo", devBuy: "5" });
    expect(await rate.actions.launch!.outcome!(intent, [launched], ctx(chain()))).toEqual({ filled: true, message: "DEMO is launched and on sale on its ladder.", facts: { Coin: COIN, Market: BOOK } });
    expect((await rate.actions.launch!.outcome!(intent, [], ctx(chain()))).filled).toBe(false);
  });
});

describe("swap on a launch coin's ladder", () => {
  const rate = createRateAdapter({ fetch: async () => { throw new Error("the index is not asked for a ladder market"); } });

  it("buys through LadderBuyer with the walk's ceiling and floor, paying the signer, and the wallet shows the floor", async () => {
    const c = chain();
    const txs = await rate.actions.swap!.build(rate.actions.swap!.intent.parse({ tokenIn: TUSD, tokenOut: COIN, amountIn: "1", maxSlippageBps: 50 }), ctx(c));
    expect(decodeFunctionData({ abi: erc20Abi, data: txs[0]!.data }).args).toEqual([LADDER, 1_000_000n]);
    expect(txs[1]!.to).toBe(LADDER);
    const [base, quote, amount, maxPrice, minOut, recipient, deadline] = decodeFunctionData({ abi: LadderBuyerABI, data: txs[1]!.data }).args as [Address, Address, bigint, bigint, bigint, Address, bigint];
    expect([base, quote, amount, maxPrice, minOut, recipient]).toEqual([COIN, TUSD, 1_000_000n, 100_500n, (990n * COINS * 9_950n) / 10_000n, ALICE]);
    expect(Number(deadline) - Date.now() / 1000).toBeGreaterThan(590);

    const decoded = await decodeRateLadderTrade(txs[1]!, ALICE, c.client);
    expect(decoded).toMatchObject({ action: "swap", contract: "ladderBuyer", spend: [{ token: TUSD, amount: 1_000_000n, listed: true }], receive: { token: COIN, minAmount: minOut, listed: false }, recipient: ALICE, unlisted: true });
  });

  it("refuses a quote that moved past the slippage limit from what the person was shown", async () => {
    const intent = rate.actions.swap!.intent.parse({ tokenIn: TUSD, tokenOut: COIN, amountIn: "1", maxSlippageBps: 50, expectedOut: "1000" });
    await expect(rate.actions.swap!.build(intent, ctx(chain()))).rejects.toMatchObject({ code: "QUOTE_MOVED" });
  });

  it("sells back into bids with a price floor and a real minimum received: the whole amount at the last price, net of fee, less the slippage", async () => {
    const txs = await rate.actions.swap!.build(rate.actions.swap!.intent.parse({ tokenIn: COIN, tokenOut: TUSD, amountIn: "500", maxSlippageBps: 50 }), ctx(chain()));
    const call = decodeFunctionData({ abi: LadderBuyerABI, data: txs[1]!.data });
    const [, , , floor, minOut] = call.args as unknown as [Address, Address, bigint, bigint, bigint];
    expect(call.functionName).toBe("sell");
    expect(floor).toBe(99_500n);
    // 500 coins at 0.001 = 0.5 tUSD (500,000 units); less the 1% taker fee = 495,000; less 0.50% = 492,525.
    expect(minOut).toBe(492_525n);
  });

  it("refuses a sell whose fresh estimate fell past the slippage limit from what the person was shown", async () => {
    const intent = rate.actions.swap!.intent.parse({ tokenIn: COIN, tokenOut: TUSD, amountIn: "500", maxSlippageBps: 50, expectedOut: "0.6" });
    await expect(rate.actions.swap!.build(intent, ctx(chain()))).rejects.toMatchObject({ code: "QUOTE_MOVED" });
  });

  it.each([
    ["pays someone else", (args: unknown[]) => [...args.slice(0, 5), MALLORY, args[6]]],
    ["accepts nothing in return", (args: unknown[]) => [...args.slice(0, 4), 0n, ...args.slice(5)]],
    ["expires more than an hour on", (args: unknown[]) => [...args.slice(0, 6), BigInt(Math.floor(Date.now() / 1000) + 7_200)]],
  ])("the wallet does not describe a ladder buy that %s", async (_name, patch) => {
    const c = chain();
    const built = await rate.actions.swap!.build(rate.actions.swap!.intent.parse({ tokenIn: TUSD, tokenOut: COIN, amountIn: "1", maxSlippageBps: 50 }), ctx(c));
    const args = decodeFunctionData({ abi: LadderBuyerABI, data: built[1]!.data }).args as unknown as unknown[];
    const data = encodeFunctionData({ abi: LadderBuyerABI, functionName: "buy", args: patch(args) as never });
    expect(await decodeRateLadderTrade(tx(LADDER, data), ALICE, c.client)).toBeNull();
  });

  it("names the approval a ladder SELL needs, marked unlisted, and nothing else", async () => {
    const approve = (token: Address, spender: Address, amount: bigint) => tx(token, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }));
    expect(await decodeRateLadderApproval(approve(COIN, LADDER, 500n * COINS), chain().client)).toMatchObject({ token: COIN, spender: LADDER, spenderKey: "ladderBuyer", amount: 500n * COINS, unlimited: false, listed: false });
    // Another spender, a token the launchpad never launched, or a graduated coin: not this decoder's.
    expect(await decodeRateLadderApproval(approve(COIN, MALLORY, 1n), chain().client)).toBeNull();
    expect(await decodeRateLadderApproval(approve(MALLORY, LADDER, 1n), chain().client)).toBeNull();
    expect(await decodeRateLadderApproval(approve(COIN, LADDER, 1n), chain({ graduated: true }).client)).toBeNull();
  });

  it("does not describe a ladder buy of a coin that has graduated", async () => {
    const built = await rate.actions.swap!.build(rate.actions.swap!.intent.parse({ tokenIn: TUSD, tokenOut: COIN, amountIn: "1", maxSlippageBps: 50 }), ctx(chain()));
    expect(await decodeRateLadderTrade(built[1]!, ALICE, chain({ graduated: true }).client)).toBeNull();
  });

  it("says when a confirmed swap filled nothing, and what it received when it did", async () => {
    const intent = { tokenIn: TUSD, tokenOut: COIN };
    const outcome = rate.actions.swap!.outcome!;
    expect(await outcome(intent, [transferLog(TUSD, LADDER, ALICE, 1_000_000n)], ctx(chain()))).toEqual({ filled: false, message: "Nothing was bought: no DEMO arrived, and 1 tUSD was returned." });
    expect(await outcome(intent, [transferLog(COIN, BOOK, ALICE, 990n * COINS)], ctx(chain()))).toEqual({ filled: true, message: "Received 990 DEMO." });
    // Coins paid to someone else are not the signer's fill.
    expect((await outcome(intent, [transferLog(COIN, BOOK, MALLORY, 990n * COINS)], ctx(chain()))).filled).toBe(false);
  });
});

describe("reads from the chain, where the market index is empty", () => {
  const rate = createRateAdapter({ fetch: async () => { throw new Error("no index"); } });

  it("lists markets with their prices and whether the coin is on its ladder", async () => {
    const out = (await rate.reads.markets!.run({}, ctx(chain()))) as { totalCount: number; markets: Array<Record<string, unknown>> };
    expect(out.totalCount).toBe(1);
    expect(out.markets[0]).toMatchObject({ market: "DEMO/tUSD", lastPrice: "0.001", bestBid: "0.0009925", bestAsk: "0.001", launchCoinOnLadder: true });
  });

  it("describes one launch coin and its ladder", async () => {
    const out = (await rate.reads.launchInfo!.run({ coin: COIN }, ctx(chain()))) as Record<string, unknown>;
    expect(out).toMatchObject({ launched: true, onLadder: true, takerFeePct: "1", lastPrice: "0.001", creator: ALICE });
    expect((out.ladder as unknown[])[0]).toEqual({ step: 1, price: "0.001", coinsLeft: "100000" });
    expect(out.quoteToBuyOutLadder).toBe("610.51");
    expect(await rate.reads.launchInfo!.run({ coin: MALLORY }, ctx(chain()))).toEqual({ launched: false, coin: MALLORY });
  });

  it("quotes a ladder buy from the ladder itself", async () => {
    const out = (await rate.reads.quote!.run({ tokenIn: TUSD, tokenOut: COIN, amountIn: "1" }, ctx(chain()))) as Record<string, unknown>;
    expect(out).toMatchObject({ available: true, estimated: true, venue: "launch ladder", estimatedOut: "990", leftoverIn: "0" });
  });
});
