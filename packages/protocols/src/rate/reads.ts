import { erc20Abi, formatUnits, getAddress, isAddress, zeroAddress, type Address } from "viem";
import { z } from "zod";
import { ProtocolError } from "../errors";
import { RANK_MEASURES, type AdapterContext, type AdapterRead, type RankMeasure } from "../types";
import { BandPoolABI, BandPoolFactoryABI, BandPositionManagerABI, MatchingEngineABI, OrderbookFactoryABI } from "./abis";
import { rateDeployment } from "./chains";
import { clean } from "../text";
import type { Gateway } from "./gateway";
import { rateManifest } from "./manifest";
import { rankMarkets, type RankMarket, type RankResult } from "./rank";
import { pairLimits } from "./spread";
import { COIN_DECIMALS, FEE_DENOM, ORDERBOOK_ABI, coinsToQuote, isLadderMarket, priceText, quoteLadderBuy, readLadder, readLaunch } from "./launchpad";

/**
 * Rate's reads.
 *
 * Market data comes from Rate's indexer gateway (the same endpoints rate.limo
 * uses); there is no onchain quoter. Token facts and balances come from the
 * chain. Gateway numbers are floats and therefore ESTIMATES: nothing here is
 * ever used to build a transaction, and every quote says `estimated: true`.
 * Amounts that must be exact (`amountBN`, `sharesBN`) are passed through as
 * base-unit strings.
 */

const SYMBOL_MAX = 24;
const NAME_MAX = 64;
const REASON_MAX = 200;
const PCT_PLACES = 6n; // decimal places kept when a band's tolerance is shown as a percentage

const addressInput = z
  .string()
  .refine((value) => isAddress(value, { strict: false }), "not an address")
  .transform((value) => getAddress(value));

/** A positive plain decimal, e.g. "10" or "0.25". No signs, exponents or separators. */
const decimalAmount = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,29})(\.[0-9]{1,36})?$/, "expected a plain decimal number")
  .refine((value) => /[1-9]/.test(value), "amount must be greater than zero");

/** An address as the gateway sends it. Validated in the schema so a malformed one is an upstream failure, never a thrown library error. */
const gatewayAddress = z
  .string()
  .refine((value) => isAddress(value, { strict: false }), "not an address")
  .transform((value) => getAddress(value));

const numberOrNull = z.number().finite().nullable().optional();

const gatewayToken = z.object({ id: gatewayAddress, symbol: z.string(), name: z.string().optional(), decimals: z.number().int().min(0).max(36) });

function listedOn(chainId: number, address: string): boolean {
  return (rateManifest.tokens[String(chainId)] ?? []).some((t) => t.address.toLowerCase() === address.toLowerCase());
}

/**
 * A token's ticker for display: the reviewed list's symbol when listed, otherwise what the contract says (cleaned,
 * and marked unlisted), otherwise null. Never used to pick a token, only to label one already chosen.
 */
async function tickerOf(ctx: AdapterContext, address: Address): Promise<{ address: Address; symbol: string | null; listed: boolean }> {
  const listed = (rateManifest.tokens[String(ctx.chainId)] ?? []).find((t) => t.address.toLowerCase() === address.toLowerCase());
  if (listed) return { address: getAddress(address), symbol: listed.symbol, listed: true };
  const symbol = await Promise.resolve()
    .then(() => ctx.client.readContract({ address, abi: erc20Abi, functionName: "symbol" }))
    .then((s) => clean(s, SYMBOL_MAX) || null, () => null);
  return { address: getAddress(address), symbol, listed: false };
}

function tokenOut(chainId: number, t: z.infer<typeof gatewayToken>) {
  return { address: t.id, symbol: clean(t.symbol, SYMBOL_MAX), name: clean(t.name ?? t.symbol, NAME_MAX), decimals: t.decimals, listed: listedOn(chainId, t.id) };
}

function requireAccount(ctx: AdapterContext): Address {
  if (!ctx.account) throw new ProtocolError("INVALID_INTENT", "this read needs a connected wallet");
  // Interpolated into a URL path below, so it is checked here rather than trusted from the caller.
  if (!isAddress(ctx.account, { strict: false })) throw new ProtocolError("INVALID_INTENT", "the connected account is not a valid address");
  return getAddress(ctx.account);
}

function float(value: number): string {
  // Gateway floats, as plain decimals. toString() would give "5e+20" for large values. Fifteen significant digits
  // is all a double holds exactly, so float noise goes: 0.004999999999999999 reads 0.005.
  return value.toLocaleString("en-US", { useGrouping: false, maximumSignificantDigits: 15 });
}

export function rateReads(gateway: Gateway): Record<string, AdapterRead<any, any>> /* eslint-disable-line @typescript-eslint/no-explicit-any */ {
  const pools: AdapterRead<{ page: number; pageSize: number }, unknown> = {
    description: "List Rate's markets (trading pairs) on the current network, busiest first. Each has the base and quote token ADDRESSES, a price, and whether each token is on Rate's reviewed list (`listed`). Use it to find a token's address from its symbol.",
    input: z.object({ page: z.number().int().min(1).max(1000).default(1), pageSize: z.number().int().min(1).max(50).default(20) }),
    async run(raw, ctx) {
      const input = this.input.parse(raw);
      const schema = z.object({
        pairs: z.array(z.object({ id: gatewayAddress, symbol: z.string(), verified: z.boolean().optional(), price: numberOrNull, dayQuoteVolumeUSD: numberOrNull, dayQuoteTvlUSD: numberOrNull, base: gatewayToken, quote: gatewayToken })),
        totalCount: z.number().int(),
        totalPages: z.number().int(),
      });
      const data = await gateway.get(ctx.chainId, `/api/pairs/${input.pageSize}/${input.page}`, schema);
      return {
        ...(data.totalCount === 0 ? { note: "Rate's market index lists nothing on this network. Use the markets read: it lists the markets from the chain itself." } : {}),
        page: input.page,
        totalPages: data.totalPages,
        totalCount: data.totalCount,
        pools: data.pairs.map((p) => ({ id: p.id, symbol: clean(p.symbol, SYMBOL_MAX * 2), verified: p.verified === true, price: p.price ?? null, dayVolumeUSD: p.dayQuoteVolumeUSD ?? null, tvlUSD: p.dayQuoteTvlUSD ?? null, base: tokenOut(ctx.chainId, p.base), quote: tokenOut(ctx.chainId, p.quote) })),
      };
    },
  };

  const quote: AdapterRead<{ tokenIn: Address; tokenOut: Address; amountIn: string }, unknown> = {
    description: "Estimate what a swap would return on Rate right now. `amountIn` is a plain decimal in whole tokens of `tokenIn` (\"50\" means 50 tokens). Returns an ESTIMATE, never a guarantee; `available: false` means there is no market.",
    input: z.object({ tokenIn: addressInput, tokenOut: addressInput, amountIn: decimalAmount }).refine((v) => v.tokenIn !== v.tokenOut, "tokenIn and tokenOut are the same token"),
    async run(raw, ctx) {
      const input = this.input.parse(raw);
      const deployment = rateDeployment(ctx.chainId);
      if (!deployment) throw new ProtocolError("UNSUPPORTED_CHAIN", `Rate is not deployed on chain ${ctx.chainId}`);
      const schema = z.union([
        z.object({
          available: z.literal(true),
          path: z.array(gatewayAddress).max(8),
          amountIn: z.number(),
          estimatedOut: z.number(),
          leftoverIn: z.number(),
          priceImpactPct: z.number(),
          hops: z.array(z.object({ pair: z.string(), side: z.string(), mktPrice: z.number(), avgPrice: z.number() })),
        }),
        z.object({ available: z.literal(false), code: z.string().optional(), reason: z.string().optional() }),
      ]);
      // A launch coin still on its ladder is priced from its ladder, onchain: the index may not know it at all.
      const ladder = await ladderQuote(ctx, input.tokenIn, input.tokenOut, input.amountIn);
      if (ladder) return ladder;
      const query = new URLSearchParams({ network: deployment.name, tokenIn: input.tokenIn, tokenOut: input.tokenOut, amountIn: input.amountIn });
      const data = await gateway.get(ctx.chainId, `/api/swap/route?${query.toString()}`, schema);
      if (!data.available) return { available: false, estimated: true, code: clean(data.code ?? "unavailable", 40), reason: clean(data.reason ?? "No market for this pair yet.", REASON_MAX) };
      const [tokenIn, tokenOut] = await Promise.all([tickerOf(ctx, input.tokenIn), tickerOf(ctx, input.tokenOut)]);
      return {
        available: true,
        estimated: true,
        tokenIn,
        tokenOut,
        path: data.path,
        amountIn: float(data.amountIn),
        estimatedOut: float(data.estimatedOut),
        leftoverIn: float(data.leftoverIn),
        priceImpactPct: data.priceImpactPct,
        hops: data.hops.map((h) => ({ pair: clean(h.pair, SYMBOL_MAX * 2), side: clean(h.side, 16), marketPrice: h.mktPrice, averagePrice: h.avgPrice })),
      };
    },
  };

  const orderbook: AdapterRead<{ base: Address; quote: Address; depth: number }, unknown> = {
    description: "Order book depth for one Rate market: bids and asks with price and size.",
    input: z.object({ base: addressInput, quote: addressInput, depth: z.number().int().min(1).max(50).default(10) }),
    async run(raw, ctx) {
      const input = this.input.parse(raw);
      const level = z.object({ price: z.string(), baseLiquidity: z.number(), quoteLiquidity: z.number() });
      const side = z.object({ buckets: z.array(level) });
      const schema = z.object({ bids: side, asks: side, spread: z.number().optional(), symbol: z.string() });
      const data = await gateway.get(ctx.chainId, `/api/orderbook/blocks/${input.base}/${input.quote}/0/${input.depth}/false`, schema);
      const levels = (s: z.infer<typeof side>) => s.buckets.map((b) => ({ price: clean(b.price, 40), base: b.baseLiquidity, quote: b.quoteLiquidity }));
      return { symbol: clean(data.symbol, SYMBOL_MAX * 2), spread: data.spread ?? null, bids: levels(data.bids), asks: levels(data.asks) };
    },
  };

  const orders: AdapterRead<{ page: number; pageSize: number }, unknown> = {
    description: "The connected wallet's open limit orders on Rate, with order ids (needed to cancel one).",
    input: z.object({ page: z.number().int().min(1).max(1000).default(1), pageSize: z.number().int().min(1).max(50).default(20) }),
    async run(raw, ctx) {
      const input = this.input.parse(raw);
      const account = requireAccount(ctx);
      const schema = z.object({
        orders: z.array(z.object({ isBid: z.boolean(), orderId: z.number().int(), pairSymbol: z.string(), price: z.number(), amountBN: z.string().regex(/^[0-9]{1,78}$/), timestamp: z.number(), assetSymbol: z.string(), assetDecimals: z.number().int(), base: gatewayToken, quote: gatewayToken })),
        totalCount: z.number().int(),
      });
      const data = await gateway.get(ctx.chainId, `/api/orders/${account}/${input.pageSize}/${input.page}`, schema);
      return {
        totalCount: data.totalCount,
        orders: data.orders.map((o) => ({ orderId: o.orderId, side: o.isBid ? "bid" : "ask", pair: clean(o.pairSymbol, SYMBOL_MAX * 2), base: o.base.id, quote: o.quote.id, price: o.price, remaining: { amount: o.amountBN, symbol: clean(o.assetSymbol, SYMBOL_MAX), decimals: o.assetDecimals }, placedAt: o.timestamp })),
      };
    },
  };

  const positions: AdapterRead<Record<string, never>, unknown> = {
    description: "The connected wallet's liquidity positions on Rate.",
    input: z.object({}),
    async run(_raw, ctx) {
      const account = requireAccount(ctx);
      // A newer gateway (Monad) answers { positions, lpPositions } and leaves bandPositions out when there are none.
      const schema = z.object({ bandPositions: z.array(z.object({ pool: gatewayAddress, tokenId: z.string().regex(/^[0-9]{1,78}$/), band: z.number().int(), sharesBN: z.string().regex(/^[0-9]{1,78}$/), base: gatewayAddress, quote: gatewayAddress, pairSymbol: z.string() })).default([]) });
      const data = await gateway.get(ctx.chainId, `/api/liquidity/positions/${account}`, schema);
      return { positions: data.bandPositions.map((p) => ({ pool: p.pool, tokenId: p.tokenId, band: p.band, shares: p.sharesBN, pair: clean(p.pairSymbol, SYMBOL_MAX * 2), base: p.base, quote: p.quote })) };
    },
  };

  const tokenInfo: AdapterRead<{ token: Address }, unknown> = {
    description: "Read a token's symbol, name and decimals from the chain, and whether it is on Rate's reviewed list. An unlisted token may be anything: say so.",
    input: z.object({ token: addressInput }),
    async run(raw, ctx) {
      const { token } = this.input.parse(raw);
      try {
        const [symbol, name, decimals] = await Promise.all([
          ctx.client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }),
          ctx.client.readContract({ address: token, abi: erc20Abi, functionName: "name" }),
          ctx.client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
        ]);
        return { address: token, symbol: clean(symbol, SYMBOL_MAX), name: clean(name, NAME_MAX), decimals: Number(decimals), listed: listedOn(ctx.chainId, token) };
      } catch (error) {
        throw new ProtocolError("UNKNOWN_TOKEN", `${token} does not answer as an ERC-20 on chain ${ctx.chainId}`, { cause: error });
      }
    },
  };

  const balances: AdapterRead<{ tokens?: Address[] }, unknown> = {
    description: "The connected wallet's balances of Rate's listed tokens and the network's gas asset, in base units with decimals. On Arc the gas asset IS USDC, reported once. Pass `tokens` to include others too, such as a coin launched or bought in this chat; those are marked unlisted, with the symbol their contract reports.",
    input: z.object({ tokens: z.array(addressInput).max(10).optional() }),
    async run(raw, ctx) {
      const input = this.input.parse(raw ?? {});
      const account = requireAccount(ctx);
      const deployment = rateDeployment(ctx.chainId);
      if (!deployment) throw new ProtocolError("UNSUPPORTED_CHAIN", `Rate is not deployed on chain ${ctx.chainId}`);
      const tokens = rateManifest.tokens[String(ctx.chainId)] ?? [];

      const [native, ...amounts] = await Promise.all([
        ctx.client.getBalance({ address: account }),
        ...tokens.map((t) => ctx.client.readContract({ address: t.address, abi: erc20Abi, functionName: "balanceOf", args: [account] })),
      ]).catch((error: unknown) => {
        throw new ProtocolError("TEMPORARILY_UNAVAILABLE", `could not read balances on ${deployment.name}`, { cause: error });
      });

      // When the chain's gas asset IS one of the listed tokens (Arc: native USDC at 18
      // decimals and the USDC ERC-20 at 6 are one pool of funds), listing both would
      // double-count it. The ERC-20 row is the balance; gas is reported on its own.
      const wrapped = deployment.contracts.weth.address.toLowerCase();
      const sameAsset = tokens.find((t) => t.address.toLowerCase() === wrapped && t.symbol === deployment.nativeCurrency.symbol);

      const gas = { symbol: deployment.nativeCurrency.symbol, decimals: deployment.nativeCurrency.decimals, amount: native.toString(), ...(sameAsset ? { sameAssetAs: sameAsset.address } : {}) };
      const rows = tokens.map((t, i) => ({ token: t.address as Address | "native", symbol: t.symbol, decimals: t.decimals, amount: (amounts[i] as bigint).toString() }));
      if (!sameAsset) rows.unshift({ token: "native", symbol: gas.symbol, decimals: gas.decimals, amount: gas.amount });
      const listed = new Set(tokens.map((t) => t.address.toLowerCase()));
      const extra = (input.tokens ?? []).map((t) => getAddress(t)).filter((t, i, all) => !listed.has(t.toLowerCase()) && all.indexOf(t) === i);
      const others = await Promise.all(
        extra.map(async (token) => {
          const [symbol, decimals, amount] = await Promise.all([
            ctx.client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }).then((s) => clean(s, SYMBOL_MAX), () => null),
            ctx.client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }).then(Number, () => null),
            ctx.client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account] }).catch(() => null),
          ]);
          return decimals === null || amount === null ? null : { token, symbol: symbol || null, decimals, amount: amount.toString(), listed: false };
        }),
      );
      return { gas, balances: [...rows, ...others.filter((r): r is NonNullable<typeof r> => r !== null)] };
    },
  };

  const pairOf = async (ctx: AdapterContext, pool: Address) => {
    const [base, quote] = await Promise.all([ctx.client.readContract({ address: pool, abi: BandPoolABI, functionName: "base" }), ctx.client.readContract({ address: pool, abi: BandPoolABI, functionName: "quote" })]);
    const [baseDecimals, quoteDecimals] = await Promise.all(
      [base, quote].map((token) =>
        ctx.client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }).catch((error: unknown) => {
          throw new ProtocolError("UNKNOWN_TOKEN", `${token} does not answer as an ERC-20 on chain ${ctx.chainId}`, { cause: error });
        }),
      ),
    );
    return { base: getAddress(base), quote: getAddress(quote), baseDecimals: Number(baseDecimals), quoteDecimals: Number(quoteDecimals) };
  };

  const bands: AdapterRead<{ base: Address; quote: Address }, unknown> = {
    description: "The liquidity bands of a pair's Rate pool, read from the chain: which are open, which are empty, and each one's reserves in base units. Accepts the pair either way round and answers in the POOL's order, which is the order addLiquidity needs. A band's reserves give the ratio a deposit must arrive at. Each band quotes a fixed fraction of the pair's limit (`reachPct`), so `tolerancePct` is how far from the market it quotes now, the tighter of its two sides; `withinReach` false means the band quotes nothing right now (the pair has no spread set), though it still takes deposits.",
    input: z.object({ base: addressInput, quote: addressInput }),
    async run(raw, ctx) {
      const input = this.input.parse(raw);
      const factory = rateManifest.contracts[String(ctx.chainId)]?.bandPoolFactory?.address;
      if (!factory) throw new ProtocolError("UNSUPPORTED_CHAIN", `Rate is not deployed on chain ${ctx.chainId}`);
      const [forward, reversed] = await Promise.all([
        ctx.client.readContract({ address: factory, abi: BandPoolFactoryABI, functionName: "getPool", args: [input.base, input.quote] }),
        ctx.client.readContract({ address: factory, abi: BandPoolFactoryABI, functionName: "getPool", args: [input.quote, input.base] }),
      ]);
      const pool = forward !== zeroAddress ? forward : reversed;
      if (pool === zeroAddress) throw new ProtocolError("INSUFFICIENT_LIQUIDITY", "Rate has no pool for this pair on this network");

      const [pair, count, denominator, limits] = await Promise.all([pairOf(ctx, pool), ctx.client.readContract({ address: pool, abi: BandPoolABI, functionName: "bandCount" }), ctx.client.readContract({ address: pool, abi: BandPoolABI, functionName: "DENOM" }), pairLimits(ctx.client, pool)]);
      if (BigInt(denominator) === 0n) throw new ProtocolError("TEMPORARILY_UNAVAILABLE", "This pool did not describe its bands in a usable way");
      const percent = (value: number | bigint) => formatUnits((BigInt(value) * 100n * 10n ** PCT_PLACES) / BigInt(denominator), Number(PCT_PLACES));
      const bandsOut = await Promise.all(
        Array.from({ length: Number(count) }, async (_, band) => {
          const [[, shares, , , open], [baseReserve, quoteReserve], [toleranceBuy, toleranceSell]] = await Promise.all([
            ctx.client.readContract({ address: pool, abi: BandPoolABI, functionName: "bands", args: [band] }),
            ctx.client.readContract({ address: pool, abi: BandPoolABI, functionName: "bandReserves", args: [band] }),
            ctx.client.readContract({ address: pool, abi: BandPoolABI, functionName: "bandTolerances", args: [band] }),
          ]);
          // A band whose tolerance rounds to zero on either side is idle for that side (BandPool's own rule).
          const tolerance = Math.min(Number(toleranceBuy), Number(toleranceSell));
          return { band, tolerancePct: percent(tolerance), withinReach: tolerance > 0, open, empty: shares === 0n, baseReserve: baseReserve.toString(), quoteReserve: quoteReserve.toString() };
        }),
      );
      return { pool: getAddress(pool), ...pair, reachPct: percent(Math.min(limits.buy, limits.sell)), bands: bandsOut };
    },
  };

  const position: AdapterRead<{ tokenId: string }, unknown> = {
    description: "One liquidity position on Rate, read from the chain, in base units: the bands it holds, the principal a withdrawal returns now, the fees already vested, and the fees that would be FORFEITED by withdrawing now rather than waiting.",
    input: z.object({ tokenId: z.string().regex(/^(0|[1-9][0-9]{0,77})$/) }),
    async run(raw, ctx) {
      const { tokenId } = this.input.parse(raw);
      const manager = rateManifest.contracts[String(ctx.chainId)]?.positionManager?.address;
      if (!manager) throw new ProtocolError("UNSUPPORTED_CHAIN", `Rate is not deployed on chain ${ctx.chainId}`);
      const view = await ctx.client.readContract({ address: manager, abi: BandPositionManagerABI, functionName: "positionOf", args: [BigInt(tokenId)] });
      if (view.pool === zeroAddress) throw new ProtocolError("INVALID_INTENT", `There is no position ${tokenId}`);
      const pair = await pairOf(ctx, view.pool);
      const sum = (pick: (band: (typeof view.bands)[number]) => bigint) => view.bands.reduce((total, band) => total + pick(band), 0n).toString();
      return {
        tokenId,
        pool: getAddress(view.pool),
        ...pair,
        bands: view.bands.map((band) => ({ band: band.band, open: band.open })),
        heldByWallet: ctx.account !== undefined && view.holder.toLowerCase() === ctx.account.toLowerCase(),
        principal: { base: sum((band) => band.baseOwned), quote: sum((band) => band.quoteOwned) },
        // Vested = what `collect` pays now: fees already locked in (`owed*`) plus the vested part of what is pending.
        feesVested: { base: (view.owedBase + BigInt(sum((band) => band.vestedBase))).toString(), quote: (view.owedQuote + BigInt(sum((band) => band.vestedQuote))).toString() },
        feesForfeitedIfRemovedNow: { base: sum((band) => band.pendingBase - band.vestedBase), quote: sum((band) => band.pendingQuote - band.vestedQuote) },
      };
    },
  };

  const RANK_PAGE_SIZE = 50;
  const rankToken = gatewayToken.extend({ weekPriceDifferencePercentage: numberOrNull, monthPriceDifferencePercentage: numberOrNull });
  const rank: AdapterRead<{ measure: RankMeasure; limit: number }, RankResult> = {
    description: "Rank Rate's listed markets by ONE measure: highest_yield (estimated LP fee APR), deepest_liquidity (TVL), most_traded (24h volume), weekly_momentum (7-day price rise), monthly_dip (largest 30-day fall), lowest_risk (deep and quiet). Use this whenever markets are compared; never compare rows of a pools read by eye. Unlisted markets and markets under the liquidity floor are left out. `none: true` means nothing qualifies: say so. Any APR here is an ESTIMATE from one day of volume. A `change7dPct` or `change30dPct` of `null` means the price change is UNKNOWN, not that the price held steady; say it is unknown, and never that such a market is quiet or safe.",
    input: z.object({ measure: z.enum(RANK_MEASURES), limit: z.number().int().min(1).max(10).default(5) }),
    async run(raw, ctx) {
      const input = this.input.parse(raw);
      const schema = z.object({ pairs: z.array(z.object({ id: gatewayAddress, symbol: z.string(), verified: z.boolean().optional(), dayQuoteVolumeUSD: numberOrNull, dayQuoteTvlUSD: numberOrNull, takerFee: numberOrNull, base: rankToken, quote: rankToken })) });
      const data = await gateway.get(ctx.chainId, `/api/pairs/${RANK_PAGE_SIZE}/1`, schema);
      const markets = data.pairs.map((p): RankMarket => ({
        id: p.id,
        symbol: clean(p.symbol, SYMBOL_MAX * 2),
        // Listed means BOTH tokens are on the reviewed list. The gateway's own `verified` flag is not trusted for this.
        listed: listedOn(ctx.chainId, p.base.id) && listedOn(ctx.chainId, p.quote.id),
        base: { address: p.base.id, symbol: clean(p.base.symbol, SYMBOL_MAX) },
        quote: { address: p.quote.id, symbol: clean(p.quote.symbol, SYMBOL_MAX) },
        tvlUSD: p.dayQuoteTvlUSD ?? 0,
        volume24hUSD: p.dayQuoteVolumeUSD ?? 0,
        takerFee: p.takerFee ?? null,
        // `null`, never 0: a change the gateway did not report is unknown, and an unknown that poses as "it did not move" is a lie about risk.
        change7dPct: p.base.weekPriceDifferencePercentage ?? null,
        change30dPct: p.base.monthPriceDifferencePercentage ?? null,
      }));
      return rankMarkets(markets, input.measure, input.limit);
    },
  };

  const MARKETS_MAX = 25;
  const markets: AdapterRead<Record<string, never>, unknown> = {
    description: "List Rate's markets on the current network straight from the chain (the order-book factory), newest last: each market's coin and quote token (ADDRESS and symbol), the last traded price (quote per coin), the best bid and ask, and whether the coin is a LAUNCH COIN still on its sell ladder (trade it with swap; it fills on the ladder). Works where the pools read is empty. Use launchInfo for one coin's ladder and launch details.",
    input: z.object({}).strict(),
    async run(_raw, ctx) {
      const contracts = rateManifest.contracts[String(ctx.chainId)];
      if (!contracts?.orderbookFactory || !contracts.matchingEngine) throw new ProtocolError("UNSUPPORTED_CHAIN", `Rate is not deployed on chain ${ctx.chainId}`);
      const total = Number(await ctx.client.readContract({ address: contracts.orderbookFactory.address, abi: OrderbookFactoryABI, functionName: "allPairsLength" }));
      if (total === 0) return { totalCount: 0, markets: [] };
      const from = Math.max(0, total - MARKETS_MAX);
      const pairs = await ctx.client.readContract({ address: contracts.orderbookFactory.address, abi: OrderbookFactoryABI, functionName: "getPairs", args: [BigInt(from), BigInt(total)] });
      const rows = await Promise.all(
        pairs.map(async ({ base, quote }) => {
          const book = await ctx.client.readContract({ address: contracts.matchingEngine!.address, abi: MatchingEngineABI, functionName: "getPair", args: [base, quote] });
          const [baseT, quoteT, lmp, heads, launch] = await Promise.all([
            tickerOf(ctx, base),
            tickerOf(ctx, quote),
            ctx.client.readContract({ address: book, abi: ORDERBOOK_ABI, functionName: "lmp" }).catch(() => 0n),
            ctx.client.readContract({ address: book, abi: ORDERBOOK_ABI, functionName: "heads" }).catch(() => [0n, 0n] as const),
            readLaunch(ctx.client, ctx.chainId, base).catch(() => null),
          ]);
          return {
            market: `${baseT.symbol ?? "?"}/${quoteT.symbol ?? "?"}`,
            coin: baseT,
            quote: quoteT,
            lastPrice: priceText(lmp),
            bestBid: heads[0] > 0n ? priceText(heads[0]) : null,
            bestAsk: heads[1] > 0n ? priceText(heads[1]) : null,
            launchCoinOnLadder: isLadderMarket(launch, getAddress(quote)),
          };
        }),
      );
      return { totalCount: total, shown: rows.length, markets: rows };
    },
  };

  const launchInfo: AdapterRead<{ coin: Address }, unknown> = {
    description: "One launch coin, read from the chain: who launched it and when, its quote token, the taker fee, whether it has graduated, the last price, and its five-step sell ladder (each step's price and the coins still for sale there), with how much quote buying out the whole remaining ladder costs. `onLadder: true` means it trades on the ladder (swap handles that). `launched: false` means the launchpad never launched this token.",
    input: z.object({ coin: addressInput }),
    async run(raw, ctx) {
      const input = this.input.parse(raw);
      const record = await readLaunch(ctx.client, ctx.chainId, input.coin);
      if (!record) return { launched: false, coin: input.coin };
      const [coinT, quoteT, ladder, quoteDecimals, lmp] = await Promise.all([
        tickerOf(ctx, input.coin),
        tickerOf(ctx, record.quote),
        readLadder(ctx.client, ctx.chainId, input.coin),
        ctx.client.readContract({ address: record.quote, abi: erc20Abi, functionName: "decimals" }).then(Number),
        ctx.client.readContract({ address: record.pair, abi: ORDERBOOK_ABI, functionName: "lmp" }).catch(() => 0n),
      ]);
      const steps = ladder?.steps ?? [];
      const toBuyOut = steps.reduce((sum, step) => sum + coinsToQuote(step.remaining, step.price, quoteDecimals), 0n);
      return {
        launched: true,
        coin: coinT,
        quote: quoteT,
        creator: record.creator,
        launchedAt: new Date(Number(record.launchedAt) * 1000).toISOString(),
        takerFeePct: (record.takerFee / Number(FEE_DENOM / 100n)).toString(),
        graduated: record.graduated,
        onLadder: !record.graduated,
        lastPrice: priceText(lmp),
        ladder: steps.map((step, i) => ({ step: i + 1, price: priceText(step.price), coinsLeft: formatUnits(step.remaining, COIN_DECIMALS) })),
        quoteToBuyOutLadder: formatUnits(toBuyOut, quoteDecimals),
      };
    },
  };

  /** A quote for a launch coin on its ladder, in the same shape as the gateway's, or null when the pair is not one. */
  async function ladderQuote(ctx: AdapterContext, tokenIn: Address, tokenOut: Address, amountIn: string) {
    const record = await readLaunch(ctx.client, ctx.chainId, tokenOut).catch(() => null);
    if (!isLadderMarket(record, tokenIn)) return null;
    const ladder = await readLadder(ctx.client, ctx.chainId, tokenOut);
    if (!ladder) return null;
    const quoteDecimals = Number(await ctx.client.readContract({ address: tokenIn, abi: erc20Abi, functionName: "decimals" }));
    const [whole, fraction = ""] = amountIn.split(".");
    if (fraction.length > quoteDecimals) throw new ProtocolError("INVALID_INTENT", `amountIn has more decimal places than the token's ${quoteDecimals}`);
    const raw = BigInt(whole!) * 10n ** BigInt(quoteDecimals) + BigInt(fraction.padEnd(quoteDecimals, "0") || "0");
    const q = quoteLadderBuy(ladder.steps, raw, quoteDecimals, 0, record.takerFee);
    const [tIn, tOut] = await Promise.all([tickerOf(ctx, tokenIn), tickerOf(ctx, tokenOut)]);
    const first = [...ladder.steps].filter((step) => step.remaining > 0n).sort((x, y) => (x.price < y.price ? -1 : 1))[0]?.price ?? 0n;
    // The average fill price on the engine's 1e8 grid: quote spent per coin bought, before the fee.
    const average = q.coinsOut > 0n ? (q.quoteUsed * 100_000_000n * 10n ** BigInt(COIN_DECIMALS - quoteDecimals)) / q.coinsOut : 0n;
    if (q.netCoinsOut === 0n) return { available: false, estimated: true, code: "ladder-empty", reason: "This launch coin's ladder has nothing left to sell." };
    return {
      available: true,
      estimated: true,
      venue: "launch ladder",
      tokenIn: tIn,
      tokenOut: tOut,
      path: [tokenIn, tokenOut],
      amountIn,
      estimatedOut: float(Number(formatUnits(q.netCoinsOut, COIN_DECIMALS))),
      leftoverIn: formatUnits(raw - q.quoteUsed, quoteDecimals),
      // How far the average fill sits above the cheapest step still for sale: the cost of climbing the ladder.
      priceImpactPct: first > 0n ? Number(((average - first) * 1_000_000n) / first) / 10_000 : 0,
      hops: [{ pair: `${tOut.symbol ?? "?"}/${tIn.symbol ?? "?"}`, side: "buyBase", marketPrice: Number(priceText(first)), averagePrice: Number(priceText(average)) }],
    };
  }

  return { pools, quote, orderbook, orders, positions, tokenInfo, balances, bands, position, rank, markets, launchInfo };
}
