import { decodeFunctionData, encodeFunctionData, getAddress, zeroAddress, type Address, type PublicClient } from "viem";
import type { DecodedAction, TxRequest } from "../types";
import { BandPoolABI, BandPoolFactoryABI, BandSwapRouterABI } from "./abis";
import { rateManifest } from "./manifest";

/**
 * Rate's swap, decoded by first-party code because it cannot be declared.
 *
 * `BandSwapRouter.swap(pool, amountIn, quoteToBase, recipient, minAmountOut)`
 * names a POOL and a direction, not tokens. So calldata alone cannot say what
 * is spent, and worse, cannot say whether `pool` is a pool at all: the router
 * would pull the user's tokens and hand them to whatever address is there.
 *
 * The decode therefore reads the chain, and nothing is believed until the
 * FACTORY vouches for it: the pool reports its base and quote, and
 * `factory.getPool(base, quote)` must return that very pool. An attacker's
 * contract can claim any pair, but the factory's entry for that pair is the
 * real pool, so the claim fails.
 *
 * Not pure, unlike the manifest decoder, and used only for this first-party
 * adapter (guideline §4). Any read failure is "unknown": null, never a throw.
 */
export async function decodeRateSwap(tx: TxRequest, signer: Address, client: PublicClient): Promise<DecodedAction | null> {
  try {
    const contracts = rateManifest.contracts[String(tx.chainId)];
    if (!contracts?.swapRouter || !contracts.bandPoolFactory) return null;
    if (tx.to.toLowerCase() !== contracts.swapRouter.address.toLowerCase() || tx.value !== 0n) return null;

    const { functionName, args } = decodeFunctionData({ abi: BandSwapRouterABI, data: tx.data });
    if (functionName !== "swap") return null;
    // One meaning per calldata, as in the manifest decoder.
    if (encodeFunctionData({ abi: BandSwapRouterABI, functionName: "swap", args }).toLowerCase() !== tx.data.toLowerCase()) return null;

    const [pool, amountIn, quoteToBase, recipient, minAmountOut] = args;
    if (amountIn <= 0n || recipient.toLowerCase() !== signer.toLowerCase() || pool === zeroAddress) return null;

    const [base, quote] = await Promise.all([
      client.readContract({ address: pool, abi: BandPoolABI, functionName: "base" }),
      client.readContract({ address: pool, abi: BandPoolABI, functionName: "quote" }),
    ]);
    const vouched = await client.readContract({ address: contracts.bandPoolFactory.address, abi: BandPoolFactoryABI, functionName: "getPool", args: [base, quote] });
    if (vouched === zeroAddress || vouched.toLowerCase() !== pool.toLowerCase()) return null;

    const listed = (token: Address) => rateManifest.tokens[String(tx.chainId)]?.find((t) => t.address.toLowerCase() === token.toLowerCase())?.address;
    const spendToken = quoteToBase ? quote : base;
    const receiveToken = quoteToBase ? base : quote;
    const spendListed = listed(spendToken);
    const receiveListed = listed(receiveToken);

    return {
      protocol: rateManifest.id,
      action: "swap",
      chainId: tx.chainId,
      contract: "swapRouter",
      spends: true,
      spend: [{ token: spendListed ?? getAddress(spendToken), amount: amountIn, listed: spendListed !== undefined }],
      receive: { token: receiveListed ?? getAddress(receiveToken), minAmount: minAmountOut, listed: receiveListed !== undefined },
      recipient: signer,
      unlisted: spendListed === undefined || receiveListed === undefined,
    };
  } catch {
    return null;
  }
}
