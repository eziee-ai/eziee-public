import { decodeEventLog, encodeFunctionData, erc20Abi, getAddress, isAddress, parseUnits, zeroAddress, type Address, type PublicClient } from "viem";
import { z } from "zod";
import { ProtocolError } from "../errors";
import type { ActionOutcome, AdapterAction, AdapterContext, AdapterRead, ReceiptLog, TxRequest } from "../types";
import { AssetGeneratorABI, BandPoolABI, BandPoolFactoryABI, BandPositionManagerABI, BandSwapRouterABI, LadderBuyerABI, MatchingEngineABI } from "./abis";
import { simulate } from "../simulate";
import { rateManifest } from "./manifest";
import { COIN_DECIMALS, FEE_DENOM, ORDERBOOK_ABI, PRICE_SCALE, generatorOn, isLadderMarket, ladderBuyerOn, ladderSellFloor, quoteLadderBuy, readLadder, readLaunch } from "./launchpad";

/**
 * Rate's actions (spec §6.1). `build` is deterministic given the chain and a
 * fresh quote; it never takes calldata, an address of a contract, or an amount
 * in base units from its caller. The caller is a language model: it supplies an
 * intent, and everything that touches a contract is derived here.
 *
 * Approvals are EXACT, to a manifest `router`-role contract only.
 */

const PRICE_DECIMALS = 8; // MatchingEngine prices are 1e8 fixed-point, whatever the tokens' decimals (verified onchain).
const ORDER_MATCH_DEPTH = 20; // `n`: how many resting orders one call may match. rate.limo uses 20.
/** The engine's slippage unit: 1e8 is 100%, so one basis point is 1e4 (Rate's apps/web/lib/orders/slippage.ts). */
const ENGINE_UNITS_PER_BPS = 10_000;
const BPS = 10_000n;
/**
 * The liquidity calls carry a deadline and a floor, as Rate's own clients set them (iter-monorepo
 * apps/mcp/src/writeTools.ts): a mint expires 20 minutes on and must mint at least 99.5% of the shares it
 * expects (the web's 0.5% tolerance); a withdrawal expires 10 minutes on and must return at least 99% of
 * what a simulation of it returns now (the MCP's default 1% slippage).
 */
const MINT_DEADLINE_S = 1_200;
const MINT_SHARES_KEEP_PER_MILLE = 995n;
const WITHDRAW_DEADLINE_S = 600;
const WITHDRAW_KEEP_BPS = 9_900n;
/** A ladder trade expires ten minutes on, as Rate's own trade tool sets it. */
const LADDER_DEADLINE_S = 600;
/** Every launch mints this many coins (18 decimals), as Rate's launch tool sends it. */
const LAUNCH_SUPPLY = 1_000_000_000n * 10n ** 18n;
const deadlineIn = (seconds: number) => BigInt(Math.floor(Date.now() / 1000) + seconds);

const address = z
  .string()
  .refine((value) => isAddress(value, { strict: false }), "not an address")
  .transform((value) => getAddress(value));
const decimal = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,29})(\.[0-9]{1,36})?$/, "expected a plain decimal number")
  .refine((value) => /[1-9]/.test(value), "must be greater than zero");

type Ctx = AdapterContext & { account: Address };

function contractsOn(chainId: number) {
  const contracts = rateManifest.contracts[String(chainId)];
  if (!contracts) throw new ProtocolError("UNSUPPORTED_CHAIN", `Rate is not deployed on chain ${chainId}`);
  return contracts;
}

async function decimalsOf(client: PublicClient, token: Address): Promise<number> {
  try {
    return Number(await client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }));
  } catch (error) {
    throw new ProtocolError("UNKNOWN_TOKEN", `${token} does not answer as an ERC-20`, { cause: error });
  }
}

/** A typed amount as exact base units. More decimals than the token has is an error, never a rounding. */
function toUnits(text: string, decimals: number, what: string): bigint {
  if ((text.split(".")[1] ?? "").length > decimals) throw new ProtocolError("INVALID_INTENT", `${what} has more decimal places than the token's ${decimals}`);
  return parseUnits(text, decimals);
}

/** An exact approval, only if the current allowance does not already cover the amount. */
async function approvalIfNeeded(ctx: Ctx, token: Address, spender: Address, amount: bigint): Promise<TxRequest[]> {
  const allowance = await ctx.client.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [ctx.account, spender] });
  if (allowance >= amount) return [];
  return [{ chainId: ctx.chainId, to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }), value: 0n }];
}

/**
 * A swap on a pair that has an order book and no pool: a market order on the matching engine. Buying when tokenOut
 * is the pair's base (the amount is the quote paid), selling when tokenIn is the base (the amount is the base sold).
 * The engine bounds the fill at the last price ± `slippageLimit`; the fresh quote has already been checked against
 * what the person was shown. What comes back goes to the signer, and an unfilled rest is returned.
 */
async function bookSwap(intent: { tokenIn: Address; tokenOut: Address; maxSlippageBps: number }, ctx: Ctx, amountIn: bigint): Promise<TxRequest[]> {
  const engine = contractsOn(ctx.chainId).matchingEngine!.address;
  const [buyPair, sellPair] = await Promise.all([
    ctx.client.readContract({ address: engine, abi: MatchingEngineABI, functionName: "getPair", args: [intent.tokenOut, intent.tokenIn] }),
    ctx.client.readContract({ address: engine, abi: MatchingEngineABI, functionName: "getPair", args: [intent.tokenIn, intent.tokenOut] }),
  ]);
  const buying = buyPair !== zeroAddress;
  if (!buying && sellPair === zeroAddress) throw new ProtocolError("INSUFFICIENT_LIQUIDITY", "Rate has no market for this pair on this network");
  const [base, quote] = buying ? [intent.tokenOut, intent.tokenIn] : [intent.tokenIn, intent.tokenOut];
  const data = encodeFunctionData({
    abi: MatchingEngineABI,
    functionName: buying ? "marketBuy" : "marketSell",
    args: [{ base, quote, amount: amountIn, isMaker: false, n: ORDER_MATCH_DEPTH, recipient: ctx.account, slippageLimit: intent.maxSlippageBps * ENGINE_UNITS_PER_BPS }],
  });
  return [...(await approvalIfNeeded(ctx, intent.tokenIn, engine, amountIn)), { chainId: ctx.chainId, to: engine, data, value: 0n }];
}

/** How much of `token` the receipt's Transfer events paid to `to`. */
function receivedBy(logs: readonly ReceiptLog[], token: Address, to: Address): bigint {
  let total = 0n;
  for (const log of logs) {
    if (log.address.toLowerCase() !== token.toLowerCase()) continue;
    try {
      const event = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics as [`0x${string}`, ...`0x${string}`[]] });
      if (event.eventName === "Transfer" && event.args.to.toLowerCase() === to.toLowerCase()) total += event.args.value;
    } catch {
      // Not a Transfer.
    }
  }
  return total;
}

async function symbolOf(client: PublicClient, token: Address): Promise<string> {
  const listed = Object.values(rateManifest.tokens).flat().find((t) => t.address.toLowerCase() === token.toLowerCase());
  if (listed) return listed.symbol;
  const raw = await client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }).catch(() => "");
  return raw.replace(/[^\p{L}\p{N}.$-]/gu, "").slice(0, 16) || "the token";
}

/** A swap is done only when the signer received some of what was bought; a refund-only fill is reported as one. */
async function swapOutcome(intent: { tokenIn: Address; tokenOut: Address }, logs: readonly ReceiptLog[], ctx: Ctx): Promise<ActionOutcome> {
  const [got, back, decimalsOut, decimalsIn, symOut, symIn] = await Promise.all([
    Promise.resolve(receivedBy(logs, intent.tokenOut, ctx.account)),
    Promise.resolve(receivedBy(logs, intent.tokenIn, ctx.account)),
    decimalsOf(ctx.client, intent.tokenOut),
    decimalsOf(ctx.client, intent.tokenIn),
    symbolOf(ctx.client, intent.tokenOut),
    symbolOf(ctx.client, intent.tokenIn),
  ]);
  if (got === 0n) return { filled: false, message: `Nothing was bought: no ${symOut} arrived${back > 0n ? `, and ${formatUnitsPlain(back, decimalsIn)} ${symIn} was returned` : ""}.` };
  return { filled: true, message: `Received ${formatUnitsPlain(got, decimalsOut)} ${symOut}${back > 0n ? `; ${formatUnitsPlain(back, decimalsIn)} ${symIn} that could not fill was returned` : ""}.` };
}

/** A base-unit amount as a plain decimal, for messages. */
function formatUnitsPlain(value: bigint, decimals: number): string {
  const s = value.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const fraction = s.slice(s.length - decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

/**
 * A swap on a launch coin's ladder, as Rate's own trade tool builds it, or null when the pair is not a ladder
 * market. A buy (quote in, coin out) walks the ladder: `maxPrice` is the highest step the fill reaches plus the
 * slippage, `minBaseOut` the coins it buys net of the taker fee less the slippage. A sell (coin in, quote out) fills
 * only into resting bids, never below the last price less the slippage. LadderBuyer pulls what is spent and pays
 * the signer; whatever cannot fill comes back.
 */
async function ladderSwap(intent: { tokenIn: Address; tokenOut: Address; maxSlippageBps: number; expectedOut?: string }, ctx: Ctx, amountIn: bigint, decimalsIn: number, decimalsOut: number): Promise<TxRequest[] | null> {
  const buyer = ladderBuyerOn(ctx.chainId);
  if (!buyer) return null;
  const [asBuy, asSell] = await Promise.all([readLaunch(ctx.client, ctx.chainId, intent.tokenOut).catch(() => null), readLaunch(ctx.client, ctx.chainId, intent.tokenIn).catch(() => null)]);
  const deadline = deadlineIn(LADDER_DEADLINE_S);
  const keep = BPS - BigInt(intent.maxSlippageBps);
  if (isLadderMarket(asBuy, intent.tokenIn)) {
    const ladder = await readLadder(ctx.client, ctx.chainId, intent.tokenOut);
    if (!ladder) throw new ProtocolError("INSUFFICIENT_LIQUIDITY", "This launch coin has no ladder to buy from");
    const q = quoteLadderBuy(ladder.steps, amountIn, decimalsIn, intent.maxSlippageBps, asBuy.takerFee);
    if (q.topPrice === 0n || q.minBaseOut <= 0n) throw new ProtocolError("INSUFFICIENT_LIQUIDITY", "This launch coin's ladder has nothing left to sell");
    if (intent.expectedOut !== undefined) {
      const floor = (toUnits(intent.expectedOut, COIN_DECIMALS, "expectedOut") * keep) / BPS;
      if (q.netCoinsOut < floor) throw new ProtocolError("QUOTE_MOVED", `The price moved: about ${formatUnitsPlain(q.netCoinsOut, COIN_DECIMALS)} now, against ${intent.expectedOut} shown`);
    }
    const data = encodeFunctionData({ abi: LadderBuyerABI, functionName: "buy", args: [intent.tokenOut, intent.tokenIn, amountIn, q.maxPrice, q.minBaseOut, ctx.account, deadline] });
    return [...(await approvalIfNeeded(ctx, intent.tokenIn, buyer, amountIn)), { chainId: ctx.chainId, to: buyer, data, value: 0n }];
  }
  if (isLadderMarket(asSell, intent.tokenOut)) {
    const last = await ctx.client.readContract({ address: asSell.pair, abi: ORDERBOOK_ABI, functionName: "lmp" });
    const floor = ladderSellFloor(last, intent.maxSlippageBps);
    // What the whole amount fetches at the last price, net of the taker fee: the estimate. The sell must return at
    // least that less the slippage, so a fill that is partial or lower than quoted reverts instead of landing cheap.
    const gross = (amountIn * last * 10n ** BigInt(decimalsOut)) / (PRICE_SCALE * 10n ** BigInt(COIN_DECIMALS));
    const estimate = gross - (gross * BigInt(asSell.takerFee)) / FEE_DENOM;
    if (intent.expectedOut !== undefined) {
      const shown = (toUnits(intent.expectedOut, decimalsOut, "expectedOut") * keep) / BPS;
      if (estimate < shown) throw new ProtocolError("QUOTE_MOVED", `The price moved: about ${formatUnitsPlain(estimate, decimalsOut)} now, against ${intent.expectedOut} shown`);
    }
    const minQuoteOut = (estimate * keep) / BPS;
    if (minQuoteOut <= 0n) throw new ProtocolError("AMOUNT_TOO_SMALL", "The amount is too small to set a minimum received");
    const data = encodeFunctionData({ abi: LadderBuyerABI, functionName: "sell", args: [intent.tokenIn, intent.tokenOut, amountIn, floor, minQuoteOut, ctx.account, deadline] });
    return [...(await approvalIfNeeded(ctx, intent.tokenIn, buyer, amountIn)), { chainId: ctx.chainId, to: buyer, data, value: 0n }];
  }
  return null;
}

export function rateActions(reads: Record<string, AdapterRead>): Record<string, AdapterAction<any>> /* eslint-disable-line @typescript-eslint/no-explicit-any */ {
  const swapIntent = z
    .object({
      tokenIn: address,
      tokenOut: address,
      amountIn: decimal,
      /** 1 = 0.01%. Capped at 50%: above that a "limit" protects nothing. */
      maxSlippageBps: z.number().int().min(1).max(5000),
      /** What the user was last shown. If the fresh quote is worse than this by more than the slippage limit, nothing is built. */
      expectedOut: decimal.optional(),
    })
    .refine((v) => v.tokenIn !== v.tokenOut, "tokenIn and tokenOut are the same token");

  const swap: AdapterAction<z.infer<typeof swapIntent>> = {
    description: "Swap one token for another on Rate: through its pool, as a market order where a pair has only an order book, or, for a LAUNCH COIN still on its sell ladder, on that ladder (buying it with its quote token, or selling it back). The ladder route is chosen automatically. Get a quote first and pass its estimated output as `expectedOut`. `amountIn` and `expectedOut` are plain decimals in whole tokens. `maxSlippageBps` is the most the result may fall short, in hundredths of a percent (50 = 0.50%). The wallet asks the person to approve; you cannot.",
    intent: swapIntent,
    async build(intent, ctx) {
      const contracts = contractsOn(ctx.chainId);
      const [decimalsIn, decimalsOut] = await Promise.all([decimalsOf(ctx.client, intent.tokenIn), decimalsOf(ctx.client, intent.tokenOut)]);
      const amountIn = toUnits(intent.amountIn, decimalsIn, "amountIn");

      // A launch coin still on its ladder trades through LadderBuyer, whatever the index knows about it.
      const ladder = await ladderSwap(intent, ctx, amountIn, decimalsIn, decimalsOut);
      if (ladder) return ladder;

      const quote = (await reads.quote!.run({ tokenIn: intent.tokenIn, tokenOut: intent.tokenOut, amountIn: intent.amountIn }, ctx)) as { available: boolean; estimatedOut?: string; leftoverIn?: string };
      if (!quote.available || !quote.estimatedOut) throw new ProtocolError("INSUFFICIENT_LIQUIDITY", "Rate has no market for this pair right now");
      if (quote.leftoverIn && /[1-9]/.test(quote.leftoverIn)) throw new ProtocolError("INSUFFICIENT_LIQUIDITY", `Only part of ${intent.amountIn} can be filled right now; ${quote.leftoverIn} would be left over`);

      const keep = BPS - BigInt(intent.maxSlippageBps);
      // The gateway's estimate is a float with up to 18 places; cut to the token's precision, rounding DOWN.
      const [whole, fraction = ""] = quote.estimatedOut.split(".");
      const estimatedOut = parseUnits(`${whole}.${fraction.slice(0, decimalsOut) || "0"}`, decimalsOut);
      if (intent.expectedOut !== undefined) {
        const floor = (toUnits(intent.expectedOut, decimalsOut, "expectedOut") * keep) / BPS;
        if (estimatedOut < floor) throw new ProtocolError("QUOTE_MOVED", `The price moved: about ${quote.estimatedOut} now, against ${intent.expectedOut} shown`);
      }
      const minOut = (estimatedOut * keep) / BPS;
      if (minOut <= 0n) throw new ProtocolError("AMOUNT_TOO_SMALL", "The amount is too small to set a minimum received");

      // getPool is order-sensitive (CREATE2 salt), so both orders are asked. quoteToBase follows from which one answered.
      const factory = contracts.bandPoolFactory!.address;
      const [asBase, asQuote] = await Promise.all([
        ctx.client.readContract({ address: factory, abi: BandPoolFactoryABI, functionName: "getPool", args: [intent.tokenIn, intent.tokenOut] }),
        ctx.client.readContract({ address: factory, abi: BandPoolFactoryABI, functionName: "getPool", args: [intent.tokenOut, intent.tokenIn] }),
      ]);
      const pool = asBase !== zeroAddress ? asBase : asQuote;
      // No pool: a pair with only an order book fills as a market order, as Rate's own trade tool does.
      if (pool === zeroAddress) return bookSwap(intent, ctx, amountIn);
      const quoteToBase = asBase === zeroAddress; // tokenIn is the pool's quote exactly when (tokenOut, tokenIn) is the pool's (base, quote)

      const router = contracts.swapRouter!.address;
      const data = encodeFunctionData({ abi: BandSwapRouterABI, functionName: "swap", args: [pool, amountIn, quoteToBase, ctx.account, minOut] });
      return [...(await approvalIfNeeded(ctx, intent.tokenIn, router, amountIn)), { chainId: ctx.chainId, to: router, data, value: 0n }];
    },
    simulate,
    outcome: swapOutcome,
  };

  const orderIntent = z
    .object({
      side: z.enum(["buy", "sell"]),
      base: address,
      quote: address,
      /** Quote per base, as a plain decimal. Scaled to the engine's 1e8 fixed point here. */
      price: decimal,
      /** A BUY's amount is in the QUOTE token (what is paid); a SELL's is in the BASE token (what is sold). */
      amount: decimal,
    })
    .refine((v) => v.base !== v.quote, "base and quote are the same token");

  const placeOrder: AdapterAction<z.infer<typeof orderIntent>> = {
    description: "Place a limit order on Rate. `price` is quote tokens per one base token, as a plain decimal. For a BUY, `amount` is how much of the QUOTE token to spend; for a SELL, `amount` is how much of the BASE token to sell. The offered tokens are held by Rate until the order fills or is cancelled.",
    intent: orderIntent,
    async build(intent, ctx) {
      const engine = contractsOn(ctx.chainId).matchingEngine!.address;
      const offered = intent.side === "buy" ? intent.quote : intent.base;
      const amount = toUnits(intent.amount, await decimalsOf(ctx.client, offered), "amount");
      const price = toUnits(intent.price, PRICE_DECIMALS, "price");
      if (price <= 0n) throw new ProtocolError("INVALID_INTENT", "price must be greater than zero");
      const data = encodeFunctionData({
        abi: MatchingEngineABI,
        functionName: intent.side === "buy" ? "limitBuy" : "limitSell",
        args: [{ base: intent.base, quote: intent.quote, price, amount, isMaker: true, n: ORDER_MATCH_DEPTH, recipient: ctx.account }],
      });
      return [...(await approvalIfNeeded(ctx, offered, engine, amount)), { chainId: ctx.chainId, to: engine, data, value: 0n }];
    },
    simulate,
  };

  const cancelIntent = z.object({ base: address, quote: address, side: z.enum(["buy", "sell"]), orderId: z.number().int().min(0).max(0xffffffff) });

  const cancelOrder: AdapterAction<z.infer<typeof cancelIntent>> = {
    description: "Cancel one of the wallet's open limit orders on Rate. Get `orderId`, `base`, `quote` and the side from the orders read.",
    intent: cancelIntent,
    async build(intent, ctx) {
      const engine = contractsOn(ctx.chainId).matchingEngine!.address;
      const data = encodeFunctionData({ abi: MatchingEngineABI, functionName: "cancelOrder", args: [intent.base, intent.quote, intent.side === "buy", intent.orderId] });
      return [{ chainId: ctx.chainId, to: engine, data, value: 0n }];
    },
    simulate,
  };

  const liquidityIntent = z
    .object({
      base: address,
      quote: address,
      /** Which band of the pool, from the bands read. Band 0 quotes closest to the market price. */
      band: z.number().int().min(0).max(255),
      baseAmount: decimal,
      quoteAmount: decimal,
    })
    .refine((v) => v.base !== v.quote, "base and quote are the same token");

  const addLiquidity: AdapterAction<z.infer<typeof liquidityIntent>> = {
    description:
      "Deposit BOTH tokens of a pair into one band of its Rate pool, minting a NEW position to the wallet. Read `bands` first: `base` and `quote` must be in the pool's own order, and the band must be open. A band that already holds liquidity takes the two tokens at ITS ratio and refunds what it cannot use, so amounts are the most that will be spent; an empty band takes exactly what is given and that sets its ratio. The mint must produce at least 99.5% of the shares expected now, or it reverts and nothing is spent.",
    intent: liquidityIntent,
    async build(intent, ctx) {
      const contracts = contractsOn(ctx.chainId);
      const factory = contracts.bandPoolFactory!.address;
      const manager = contracts.positionManager!.address;

      // getPool is order-sensitive. Unlike a swap there is no direction flag to absorb a reversed pair, so say so.
      const pool = await ctx.client.readContract({ address: factory, abi: BandPoolFactoryABI, functionName: "getPool", args: [intent.base, intent.quote] });
      if (pool === zeroAddress) {
        const reversed = await ctx.client.readContract({ address: factory, abi: BandPoolFactoryABI, functionName: "getPool", args: [intent.quote, intent.base] });
        if (reversed !== zeroAddress) throw new ProtocolError("INVALID_INTENT", "This pair's pool has base and quote the other way round. Read `bands` and use its order.");
        throw new ProtocolError("INSUFFICIENT_LIQUIDITY", "Rate has no pool for this pair on this network");
      }

      const count = await ctx.client.readContract({ address: pool, abi: BandPoolABI, functionName: "bandCount" });
      if (BigInt(intent.band) >= count) throw new ProtocolError("INVALID_INTENT", `This pool has no band ${intent.band}; it has ${count}`);
      const [[, shares, , , open], [baseReserve, quoteReserve], baseDecimals, quoteDecimals] = await Promise.all([
        ctx.client.readContract({ address: pool, abi: BandPoolABI, functionName: "bands", args: [intent.band] }),
        ctx.client.readContract({ address: pool, abi: BandPoolABI, functionName: "bandReserves", args: [intent.band] }),
        decimalsOf(ctx.client, intent.base),
        decimalsOf(ctx.client, intent.quote),
      ]);
      if (!open) throw new ProtocolError("INVALID_INTENT", `Band ${intent.band} is closed to new deposits`);

      const baseAmount = toUnits(intent.baseAmount, baseDecimals, "baseAmount");
      const quoteAmount = toUnits(intent.quoteAmount, quoteDecimals, "quoteAmount");
      // The pool's own rule (BandPool._price): an empty band mints one share per unit of the token that opens it;
      // a funded band mints the smaller side's fraction, rounded down. Zero shares reverts, after approvals were paid for.
      const byBase = baseReserve === 0n ? null : (baseAmount * shares) / baseReserve;
      const byQuote = quoteReserve === 0n ? null : (quoteAmount * shares) / quoteReserve;
      const expected = shares === 0n ? baseAmount : byBase === null ? byQuote : byQuote === null ? byBase : byBase < byQuote ? byBase : byQuote;
      if (expected === null || expected === 0n) throw new ProtocolError("AMOUNT_TOO_SMALL", "These amounts are too small to mint a share of this band at its current ratio");

      const data = encodeFunctionData({
        abi: BandPositionManagerABI,
        functionName: "mint",
        args: [{ pool, bands: [intent.band], baseAmounts: [baseAmount], quoteAmounts: [quoteAmount], minShares: [(expected * MINT_SHARES_KEEP_PER_MILLE) / 1_000n], recipient: ctx.account, deadline: deadlineIn(MINT_DEADLINE_S) }],
      });
      return [...(await approvalIfNeeded(ctx, intent.base, manager, baseAmount)), ...(await approvalIfNeeded(ctx, intent.quote, manager, quoteAmount)), { chainId: ctx.chainId, to: manager, data, value: 0n }];
    },
    simulate,
  };

  const positionIntent = z.object({ tokenId: z.string().regex(/^(0|[1-9][0-9]{0,77})$/, "expected a position id as a whole number") });

  /** Both pay out to the wallet itself, and only for a position the wallet holds: an operator approval is not this app's business. */
  const heldPosition = async (intent: z.infer<typeof positionIntent>, ctx: Ctx) => {
    const manager = contractsOn(ctx.chainId).positionManager!.address;
    const tokenId = BigInt(intent.tokenId);
    const holder = await ctx.client.readContract({ address: manager, abi: BandPositionManagerABI, functionName: "holderOf", args: [tokenId] });
    if (holder.toLowerCase() !== ctx.account.toLowerCase()) throw new ProtocolError("INVALID_INTENT", `This wallet does not hold position ${intent.tokenId}`);
    return { manager, tokenId };
  };

  const removeLiquidity: AdapterAction<z.infer<typeof positionIntent>> = {
    description: "Withdraw ALL of one liquidity position on Rate to the wallet. Get `tokenId` from the positions read, and read `position` first: fees that have not vested yet are forfeited on withdrawal, so tell the person how much. The withdrawal must return at least 99% of what it would return now, or it reverts.",
    intent: positionIntent,
    async build(intent, ctx) {
      const { manager, tokenId } = await heldPosition(intent, ctx);
      const deadline = deadlineIn(WITHDRAW_DEADLINE_S);
      // The floor comes from the chain itself: what this exact withdrawal returns now, less the tolerance.
      let out: readonly [bigint, bigint];
      try {
        ({ result: out } = await ctx.client.simulateContract({ account: ctx.account, address: manager, abi: BandPositionManagerABI, functionName: "decreaseLiquidity", args: [tokenId, Number(BPS), 0n, 0n, ctx.account, deadline] }));
      } catch {
        throw new ProtocolError("TEMPORARILY_UNAVAILABLE", `Position ${intent.tokenId} cannot be withdrawn right now`);
      }
      const [minBase, minQuote] = out.map((amount) => (amount * WITHDRAW_KEEP_BPS) / BPS) as [bigint, bigint];
      const data = encodeFunctionData({ abi: BandPositionManagerABI, functionName: "decreaseLiquidity", args: [tokenId, Number(BPS), minBase, minQuote, ctx.account, deadline] });
      return [{ chainId: ctx.chainId, to: manager, data, value: 0n }];
    },
    simulate,
  };

  const collectFees: AdapterAction<z.infer<typeof positionIntent>> = {
    description: "Claim the vested fees of one liquidity position on Rate to the wallet, leaving the position in place. Get `tokenId` from the positions read.",
    intent: positionIntent,
    async build(intent, ctx) {
      const { manager, tokenId } = await heldPosition(intent, ctx);
      const data = encodeFunctionData({ abi: BandPositionManagerABI, functionName: "collect", args: [tokenId, ctx.account] });
      return [{ chainId: ctx.chainId, to: manager, data, value: 0n }];
    },
    simulate,
  };

  const launchIntent = z.object({
    /** Shown on the wallet card and stored onchain, so plain text only. */
    // A refine, not a regex: the pattern needs Unicode classes (\p{L}), which the model APIs reject in a tool schema.
    name: z.string().trim().min(1).max(64).refine((v) => /^[\p{L}\p{N} .,'&!?-]+$/u.test(v), "letters, digits, spaces and simple punctuation only"),
    symbol: z.string().trim().min(1).max(16).regex(/^[A-Za-z0-9]+$/, "letters and digits only"),
    /** In whole tokens of the quote token. At least the launchpad's minimum for that quote. */
    devBuy: decimal,
    /** Defaults to the network's first launch quote token the reviewed list carries. */
    quote: address.optional(),
  });

  const launch: AdapterAction<z.infer<typeof launchIntent>> = {
    description: "Launch a new coin on Rate's launchpad: 1,000,000,000 supply, a first buy of `devBuy` (whole tokens of the quote token, at least the launchpad's minimum) by the person launching, and a five-step sell ladder others buy from. `symbol` is the ticker (letters and digits). `quote` defaults to the network's first enabled launch quote token. The wallet shows the name, ticker and the dev buy, and always asks. The new coin's address comes back once it is confirmed.",
    intent: launchIntent,
    async build(intent, ctx) {
      const generator = generatorOn(ctx.chainId);
      if (!generator) throw new ProtocolError("UNSUPPORTED_CHAIN", `Rate has no launchpad on chain ${ctx.chainId}`);
      const listed = rateManifest.tokens[String(ctx.chainId)] ?? [];
      let quote = intent.quote;
      if (!quote) {
        const enabled = await ctx.client.readContract({ address: generator, abi: AssetGeneratorABI, functionName: "enabledQuoteTokens" });
        quote = enabled.map((a) => getAddress(a)).find((a) => listed.some((t) => t.address.toLowerCase() === a.toLowerCase()));
        if (!quote) throw new ProtocolError("INVALID_INTENT", "This network's launchpad has no launch quote token on the reviewed list");
      }
      if (!listed.some((t) => t.address.toLowerCase() === quote!.toLowerCase())) throw new ProtocolError("INVALID_INTENT", "Launch only in a quote token on Rate's reviewed list");
      const [fee, option, deferred, decimals] = await Promise.all([
        ctx.client.readContract({ address: generator, abi: AssetGeneratorABI, functionName: "launchFee" }),
        ctx.client.readContract({ address: generator, abi: AssetGeneratorABI, functionName: "quoteOption", args: [quote] }),
        // Not every deployment has this flag; one without it places the ladder in the launch itself.
        ctx.client.readContract({ address: generator, abi: AssetGeneratorABI, functionName: "ladderDeferred" }).catch(() => false),
        decimalsOf(ctx.client, quote),
      ]);
      if (!option.enabled) throw new ProtocolError("INVALID_INTENT", "Launches in this quote token are switched off on this network");
      // A deferred ladder needs a second transaction naming the new coin, which only the first one's receipt knows.
      if (deferred) throw new ProtocolError("UNSUPPORTED_CHAIN", "This network places a launch's ladder in a second transaction, which this app does not do yet");
      const devRaw = toUnits(intent.devBuy, decimals, "devBuy");
      if (devRaw < option.minDevBuy) throw new ProtocolError("INVALID_INTENT", `The dev buy must be at least ${formatUnitsPlain(option.minDevBuy, decimals)} on this network`);
      const data = encodeFunctionData({ abi: AssetGeneratorABI, functionName: "launch", args: [intent.name.trim(), intent.symbol.trim().toUpperCase(), LAUNCH_SUPPLY, quote, devRaw, 0] });
      return [...(await approvalIfNeeded(ctx, quote, generator, devRaw)), { chainId: ctx.chainId, to: generator, data, value: fee }];
    },
    simulate,
    async outcome(intent, logs, ctx) {
      const generator = generatorOn(ctx.chainId);
      for (const log of logs) {
        if (!generator || log.address.toLowerCase() !== generator.toLowerCase()) continue;
        try {
          const event = decodeEventLog({ abi: AssetGeneratorABI, data: log.data, topics: log.topics as [`0x${string}`, ...`0x${string}`[]] });
          if (event.eventName === "Launched") {
            const { coin, pair } = event.args as unknown as { coin: Address; pair: Address };
            const ticker = intent.symbol.trim().toUpperCase();
            return { filled: true, message: `${ticker} is launched and on sale on its ladder.`, facts: { Coin: getAddress(coin), Market: getAddress(pair) } };
          }
        } catch {
          // Another event of the generator.
        }
      }
      return { filled: false, message: "The launch transaction confirmed, but its Launched event was not in the receipt. Check the explorer before launching again." };
    },
  };

  return { swap, placeOrder, cancelOrder, addLiquidity, removeLiquidity, collectFees, launch };
}
