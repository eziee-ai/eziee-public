import { decodeFunctionData, encodeFunctionData, getAddress, zeroAddress, type Address, type PublicClient } from "viem";
import type { DecodedAction, Spend, TxRequest } from "../types";
import { BandPoolABI, BandPoolFactoryABI, BandPositionManagerABI, MatchingEngineABI } from "./abis";
import { rateManifest } from "./manifest";

/**
 * Rate's add-liquidity, decoded by first-party code for the same reason as the
 * swap (see decodeSwap.ts): `mint({ pool, bands, baseAmounts, quoteAmounts,
 * minShares, recipient, deadline })` names a POOL, not tokens. The position manager pulls both tokens from the
 * caller and then approves and calls whatever address `pool` is, so a pool
 * nobody vouches for is simply a thief with a familiar interface.
 *
 * Nothing is believed until the FACTORY vouches: the pool reports its base and
 * quote, and `factory.getPool(base, quote)` must return that very pool.
 *
 * The position is minted to `recipient`, which must be the signer: a deposit
 * that hands the position to anyone else is not a known action, and the wallet
 * falls back to raw calldata. Only ONE band is decoded, as the builder makes:
 * a ladder of bands is a different deposit nobody reviewed here. There is no
 * promised return. What comes back is a position, and any part of the deposit
 * the band's ratio cannot use is refunded to the caller, so the amounts here are
 * the MOST that can be spent.
 *
 * The card shows neither the share floor nor the deadline, so the decoder holds them to what the builder makes: a
 * floor above zero (a zero floor lets a deposit be diluted at any price) and a deadline that has not passed and is
 * at most an hour away (a far one lets a signed deposit be held back and landed later, at a worse price).
 *
 * Withdrawing and collecting fees need none of this: they name a position id,
 * the manager looks the pool up in its own storage, and the manifest declares
 * them with the recipient pinned to the signer.
 */
/** The latest deadline a decoded deposit may carry. The builder sets 20 minutes. */
const MAX_DEADLINE_S = 3_600n;

export async function decodeRateAddLiquidity(tx: TxRequest, signer: Address, client: PublicClient): Promise<DecodedAction | null> {
  try {
    const contracts = rateManifest.contracts[String(tx.chainId)];
    if (!contracts?.positionManager || !contracts.bandPoolFactory) return null;
    if (tx.to.toLowerCase() !== contracts.positionManager.address.toLowerCase() || tx.value !== 0n) return null;

    const { functionName, args } = decodeFunctionData({ abi: BandPositionManagerABI, data: tx.data });
    if (functionName !== "mint") return null;
    // One meaning per calldata, as in the manifest decoder.
    if (encodeFunctionData({ abi: BandPositionManagerABI, functionName: "mint", args }).toLowerCase() !== tx.data.toLowerCase()) return null;

    const [{ pool, bands, baseAmounts, quoteAmounts, minShares, recipient, deadline }] = args;
    if (bands.length !== 1 || baseAmounts.length !== 1 || quoteAmounts.length !== 1 || minShares.length !== 1) return null;
    if (recipient.toLowerCase() !== signer.toLowerCase()) return null;
    if (minShares[0] === 0n) return null;
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (deadline <= now || deadline > now + MAX_DEADLINE_S) return null;
    const [band, baseAmount, quoteAmount] = [bands[0]!, baseAmounts[0]!, quoteAmounts[0]!];
    // BOTH sides, always. The builder never makes a one-sided deposit (the pool would refund it whole), so one can
    // only come from somewhere else; and with a single token spent it would become eligible for a rule, which a
    // deposit into a pool and band the rule never names must not be.
    if (pool === zeroAddress || baseAmount === 0n || quoteAmount === 0n) return null;

    const [base, quote] = await Promise.all([
      client.readContract({ address: pool, abi: BandPoolABI, functionName: "base" }),
      client.readContract({ address: pool, abi: BandPoolABI, functionName: "quote" }),
    ]);
    const vouched = await client.readContract({ address: contracts.bandPoolFactory.address, abi: BandPoolFactoryABI, functionName: "getPool", args: [base, quote] });
    if (vouched === zeroAddress || vouched.toLowerCase() !== pool.toLowerCase()) return null;

    const spendOf = (token: Address, amount: bigint): Spend[] => {
      const listed = rateManifest.tokens[String(tx.chainId)]?.find((t) => t.address.toLowerCase() === token.toLowerCase())?.address;
      return [{ token: listed ?? getAddress(token), amount, listed: listed !== undefined }];
    };
    const spend = [...spendOf(base, baseAmount), ...spendOf(quote, quoteAmount)];

    return {
      protocol: rateManifest.id,
      action: "addLiquidity",
      chainId: tx.chainId,
      contract: "positionManager",
      spends: true,
      spend,
      recipient: signer,
      unlisted: spend.some((entry) => !entry.listed),
      venue: { pool: getAddress(pool), band },
    };
  } catch {
    return null;
  }
}

/**
 * True when a call to the position manager is a withdrawal the wallet must NOT describe as one. The manifest pins
 * its recipient to the signer but cannot hold its other arguments, and the card shows neither the floors nor the
 * deadline: a withdrawal with no floor on either side takes whatever a manipulated pool pays, and a far deadline
 * lets a signed withdrawal be held back and landed later. Such a call is left to the raw-calldata card.
 */
export function isUnguardedRateWithdrawal(tx: TxRequest): boolean {
  const manager = rateManifest.contracts[String(tx.chainId)]?.positionManager;
  if (!manager || tx.to.toLowerCase() !== manager.address.toLowerCase()) return false;
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: BandPositionManagerABI, data: tx.data });
  } catch {
    return false;
  }
  if (decoded.functionName !== "decreaseLiquidity") return false;
  const [, , minBase, minQuote, , deadline] = decoded.args;
  const now = BigInt(Math.floor(Date.now() / 1000));
  return (minBase === 0n && minQuote === 0n) || deadline <= now || deadline > now + MAX_DEADLINE_S;
}

/**
 * The widest market order described as a swap: 5% in engine units (1e8 is 100%). The card does not show the limit,
 * so anything wider is left to the raw-calldata card, whatever the builder was asked for.
 */
const MAX_MARKET_SLIPPAGE = 5_000_000;
/** The most resting orders the builder lets one market order match (`ORDER_MATCH_DEPTH` in actions.ts). */
const MAX_MARKET_MATCHES = 20;

/**
 * True when a market order on the matching engine must NOT be described as a swap. The manifest pins its recipient
 * but cannot hold its slippage limit, and the card does not show it: a limit of 0 means "the venue's default", not
 * "none", and one above what the builder ever sends lets the fill land far from the quote the person saw.
 */
export function isUnguardedRateMarketOrder(tx: TxRequest): boolean {
  const engine = rateManifest.contracts[String(tx.chainId)]?.matchingEngine;
  if (!engine || tx.to.toLowerCase() !== engine.address.toLowerCase()) return false;
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: MatchingEngineABI, data: tx.data });
  } catch {
    return false;
  }
  if (decoded.functionName !== "marketBuy" && decoded.functionName !== "marketSell") return false;
  // Only what the builder makes: a taker (a maker order would rest on the book, unseen), matching 1 to 20 orders.
  const [{ slippageLimit, isMaker, n }] = decoded.args;
  return isMaker || n === 0 || n > MAX_MARKET_MATCHES || slippageLimit === 0 || slippageLimit > MAX_MARKET_SLIPPAGE;
}
