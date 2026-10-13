/**
 * What "Max" means on a deposit, when the thing being deposited also pays for
 * the deposit.
 *
 * ## The Arc case is the whole reason this is a module
 *
 * On most chains the asset and the gas are different tokens, so Max is just the
 * balance. On Arc the gas asset IS USDC — `nativeCurrency.symbol` is literally
 * "USDC" — so a Max that sends the entire balance leaves nothing to pay the
 * transfer with, and the wallet rejects it. The user sees a Max button produce
 * an amount that cannot be sent, which is worse than no Max button.
 *
 * ## Two decimal views of ONE pool of funds
 *
 * This is the trap apps/web/CLAUDE.md records twice, and it is easy to write
 * backwards. On Arc:
 *
 *   - the USDC ERC-20 at 0x3600… reports **6** decimals
 *   - the native/gas view of the same funds reports **18**
 *
 * They are not two assets. Gas is quoted in the 18-decimal view, the balance is
 * read in the 6-decimal one, and subtracting one from the other without scaling
 * is a 10^12 error — which here means reserving a trillion times too much (Max
 * becomes 0) or a trillion times too little (Max is unsendable). So the scale
 * is derived from the two decimal counts and applied explicitly, never assumed.
 *
 * ## The reserve is a FLOOR, deliberately over-estimated
 *
 * Nothing here knows what the transfer will actually cost — gas price moves
 * between this calculation and the send. Erring high costs the user a fraction
 * of a cent left behind; erring low costs them a failed transaction and a
 * wasted wallet prompt. So the reserve doubles the estimate and rounds UP.
 */

/** A plain native send. Fixed by the EVM, not an estimate. */
export const NATIVE_TRANSFER_GAS = BigInt(21_000);

/**
 * An ERC-20 `transfer`. A real one is ~35k–55k depending on whether the
 * recipient's balance slot is already warm; 65k is the generous end, which is
 * the direction to be wrong in.
 */
export const ERC20_TRANSFER_GAS = BigInt(65_000);

/**
 * Doubles the reserve. Testnet gas prices move between the read and the send,
 * and the cost of being wrong is asymmetric — see the header.
 */
export const GAS_SAFETY_MULTIPLIER = BigInt(2);

/**
 * Does this asset pay for its own transfer?
 *
 * Compared against the chain REGISTRY's native symbol, never a hardcoded list.
 * `utils/order.ts`'s `isNativeSymbol` is such a list — ETH/NEON/INJ/IP/MON/STT
 * — and has never contained USDC, so it does not recognise Arc's gas asset at
 * all. The same rule `nativeIconFrom` follows for artwork.
 *
 * A symbol match is enough HERE because the question is about the chain's own
 * gas asset, which the registry names, and because being wrong is bounded: a
 * false positive reserves gas that did not need reserving. It must not be
 * reused to decide what something is worth.
 */
export function paysItsOwnGas(
  assetSymbol: string | undefined,
  nativeSymbol: string | undefined,
): boolean {
  if (!assetSymbol || !nativeSymbol) return false;
  return assetSymbol.toUpperCase() === nativeSymbol.toUpperCase();
}

/**
 * Gas to hold back, expressed in the ASSET's smallest unit.
 *
 * Rounds UP on the decimal conversion: leaving one extra base unit behind is
 * free, and being one short is a failed send.
 */
export function gasReserve({
  gasPrice,
  gasLimit,
  nativeDecimals,
  assetDecimals,
}: {
  /** Wei per gas, in the native view. Null when it could not be read. */
  gasPrice: bigint | null;
  gasLimit: bigint;
  nativeDecimals: number;
  assetDecimals: number;
}): bigint {
  if (gasPrice === null || gasPrice <= BigInt(0)) return BigInt(0);

  const costInNative = gasPrice * gasLimit * GAS_SAFETY_MULTIPLIER;

  if (assetDecimals === nativeDecimals) return costInNative;

  if (assetDecimals < nativeDecimals) {
    // Arc: 18 -> 6. Divide, rounding up, so a sub-unit cost still reserves one.
    const scale = BigInt(10) ** BigInt(nativeDecimals - assetDecimals);
    return (costInNative + scale - BigInt(1)) / scale;
  }

  // The other direction is not a shape any served chain has, but it is one line
  // and leaving it to overflow into a wrong number would be worse.
  return costInNative * BigInt(10) ** BigInt(assetDecimals - nativeDecimals);
}

/**
 * The largest amount this wallet can actually deposit, in the asset's smallest
 * unit.
 *
 * Never negative: a balance smaller than the reserve yields 0, which renders as
 * an empty Max rather than a nonsense one.
 */
export function maxDepositable({
  held,
  paysGas,
  gasPrice,
  gasLimit,
  nativeDecimals,
  assetDecimals,
}: {
  held: bigint;
  /** True when spending this asset is also how the transfer is paid for. */
  paysGas: boolean;
  gasPrice: bigint | null;
  gasLimit: bigint;
  nativeDecimals: number;
  assetDecimals: number;
}): bigint {
  if (held <= BigInt(0)) return BigInt(0);
  if (!paysGas) return held;

  const reserve = gasReserve({ gasPrice, gasLimit, nativeDecimals, assetDecimals });
  return held > reserve ? held - reserve : BigInt(0);
}

/** Which gas limit applies to the transfer this deposit will make. */
export function transferGasLimit(isErc20: boolean): bigint {
  return isErc20 ? ERC20_TRANSFER_GAS : NATIVE_TRANSFER_GAS;
}
