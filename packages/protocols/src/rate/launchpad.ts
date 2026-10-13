import { getAddress, parseAbi, zeroAddress, type Address, type PublicClient } from "viem";
import { AssetGeneratorABI } from "./abis";
import { rateManifest } from "./manifest";

/**
 * Rate's launchpad, read from the chain.
 *
 * A coin launched by the AssetGenerator sells as five resting asks (its "ladder"), each a step above the last,
 * owned by an escrow. Until it graduates it trades through LadderBuyer, which sends up to five taker orders in one
 * transaction and refunds what cannot fill; a plain market order keeps the pair's slippage cap and never climbs a
 * step. The arithmetic below is ported from Rate's own client (iter-monorepo apps/web/lib/launch/ladderBuy.ts) so
 * the floors this app sets are the ones Rate's interface sets.
 */

/** Every launched coin has 18 decimals (the generator mints them). */
export const COIN_DECIMALS = 18;
/** Engine prices are quote per base on a 1e8 grid. */
export const PRICE_SCALE = 100_000_000n;
/** `MatchingEngine.DENOM`: a taker fee of 1% is 1_000_000. */
export const FEE_DENOM = 100_000_000n;
const TEN = 10n;

/** The one Orderbook read the ladder needs; the book has no vendored ABI (Rate ships none for it either). */
export const ORDERBOOK_ABI = parseAbi([
  "function getOrder(bool isBid, uint32 orderId) view returns ((address owner, uint256 price, uint256 depositAmount, uint64 deadline))",
  "function lmp() view returns (uint256)",
  "function heads() view returns (uint256, uint256)",
]);

export interface LaunchRecord {
  creator: Address;
  quote: Address;
  pair: Address;
  launchedAt: bigint;
  /** On the engine's 1e8 scale. */
  takerFee: number;
  graduated: boolean;
}

export interface LadderStep {
  /** Engine price, 1e8. */
  price: bigint;
  /** Coins still resting at this step, raw (18 decimals). */
  remaining: bigint;
}

export function generatorOn(chainId: number): Address | undefined {
  return rateManifest.contracts[String(chainId)]?.assetGenerator?.address;
}

export function ladderBuyerOn(chainId: number): Address | undefined {
  return rateManifest.contracts[String(chainId)]?.ladderBuyer?.address;
}

/** The generator's record of `coin`, or null when it never launched it. */
export async function readLaunch(client: PublicClient, chainId: number, coin: Address): Promise<LaunchRecord | null> {
  const generator = generatorOn(chainId);
  if (!generator) return null;
  const [creator, quote, pair, launchedAt, , , takerFee, , graduated] = await client.readContract({ address: generator, abi: AssetGeneratorABI, functionName: "launches", args: [coin] });
  if (creator === zeroAddress) return null;
  return { creator: getAddress(creator), quote: getAddress(quote), pair: getAddress(pair), launchedAt: BigInt(launchedAt), takerFee: Number(takerFee), graduated };
}

/** True when `coin`/`quote` is a launch coin still selling its ladder: it trades through LadderBuyer. */
export function isLadderMarket(record: LaunchRecord | null, quote: Address): record is LaunchRecord {
  return record !== null && !record.graduated && record.quote.toLowerCase() === quote.toLowerCase();
}

/** The ladder's five steps as the book holds them now. A step the escrow no longer owns has nothing left. */
export async function readLadder(client: PublicClient, chainId: number, coin: Address): Promise<{ pair: Address; escrow: Address; steps: LadderStep[] } | null> {
  const generator = generatorOn(chainId);
  if (!generator) return null;
  const ladder = await client.readContract({ address: generator, abi: AssetGeneratorABI, functionName: "ladderOf", args: [coin] });
  if (ladder.pair === zeroAddress) return null;
  const escrow = ladder.escrow.toLowerCase();
  const orders = await Promise.all(ladder.askIds.map((id) => client.readContract({ address: ladder.pair, abi: ORDERBOOK_ABI, functionName: "getOrder", args: [false, id] })));
  return {
    pair: getAddress(ladder.pair),
    escrow: getAddress(ladder.escrow),
    steps: orders.map((o) => ({ price: o.price, remaining: o.owner.toLowerCase() === escrow ? o.depositAmount : 0n })),
  };
}

/** `Orderbook.convert(price, coins, true)` for an 18-decimal coin: coins -> quote. */
export function coinsToQuote(coins: bigint, price: bigint, quoteDecimals: number): bigint {
  const scaled = (coins * price) / PRICE_SCALE;
  return quoteDecimals <= COIN_DECIMALS ? scaled / TEN ** BigInt(COIN_DECIMALS - quoteDecimals) : scaled * TEN ** BigInt(quoteDecimals - COIN_DECIMALS);
}

/** `Orderbook.convert(price, quote, false)`: quote -> coins. */
export function quoteToCoins(quote: bigint, price: bigint, quoteDecimals: number): bigint {
  if (price <= 0n) return 0n;
  const scaled = (quote * PRICE_SCALE) / price;
  return quoteDecimals <= COIN_DECIMALS ? scaled * TEN ** BigInt(COIN_DECIMALS - quoteDecimals) : scaled / TEN ** BigInt(quoteDecimals - COIN_DECIMALS);
}

export interface LadderBuyQuote {
  /** Coins the walk expects to fill, raw, before the taker fee. */
  coinsOut: bigint;
  /** What the buyer receives: `coinsOut` net of the taker fee. */
  netCoinsOut: bigint;
  /** `LadderBuyer.buy`'s `minBaseOut`: `netCoinsOut` lowered by the slippage. */
  minBaseOut: bigint;
  /** Quote the walk expects to spend. Anything above it is refunded. */
  quoteUsed: bigint;
  /** Highest step the fill reaches (1e8). Zero when nothing fills. */
  topPrice: bigint;
  /** `LadderBuyer.buy`'s `maxPrice`: `topPrice` raised by the slippage, rounded up. */
  maxPrice: bigint;
}

/** Walk the ladder for a buy of `quoteIn`, cheapest step first, rounding coins DOWN as the book does. */
export function quoteLadderBuy(steps: readonly LadderStep[], quoteIn: bigint, quoteDecimals: number, slippageBps: number, takerFee: number): LadderBuyQuote {
  let left = quoteIn;
  let coinsOut = 0n;
  let topPrice = 0n;
  const sorted = [...steps].filter((s) => s.remaining > 0n).sort((a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : 0));
  for (const step of sorted) {
    if (left <= 0n) break;
    const stepCost = coinsToQuote(step.remaining, step.price, quoteDecimals);
    if (left >= stepCost && stepCost > 0n) {
      coinsOut += step.remaining;
      left -= stepCost;
    } else {
      coinsOut += quoteToCoins(left, step.price, quoteDecimals);
      left = 0n;
    }
    topPrice = step.price;
  }
  const bps = BigInt(Math.max(0, Math.round(slippageBps)));
  const maxPrice = topPrice > 0n ? (topPrice * (10_000n + bps) + 9_999n) / 10_000n : 0n;
  const netCoinsOut = coinsOut - (coinsOut * BigInt(takerFee)) / FEE_DENOM;
  const minBaseOut = (netCoinsOut * (10_000n - bps)) / 10_000n;
  return { coinsOut, netCoinsOut, minBaseOut, quoteUsed: quoteIn - left, topPrice, maxPrice };
}

/** A sell's price floor: the last traded price lowered by the slippage, rounded down, never zero. */
export function ladderSellFloor(lastPrice: bigint, slippageBps: number): bigint {
  const bps = BigInt(Math.max(0, Math.min(10_000, Math.round(slippageBps))));
  const floor = (lastPrice * (10_000n - bps)) / 10_000n;
  return floor > 0n ? floor : 1n;
}

/** An engine price as a plain decimal of quote per coin, for reading. */
export function priceText(price: bigint): string {
  const whole = price / PRICE_SCALE;
  const fraction = (price % PRICE_SCALE).toString().padStart(8, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
