import { describe, expect, it } from "vitest";
import {
  ERC20_TRANSFER_GAS,
  GAS_SAFETY_MULTIPLIER,
  NATIVE_TRANSFER_GAS,
  gasReserve,
  maxDepositable,
  paysItsOwnGas,
  transferGasLimit,
} from "./depositMax";

/**
 * Max on a deposit, and the 10^12 error it has to avoid.
 *
 * Every case below is money: a Max that is too high produces an amount the
 * wallet refuses, and one that is too low silently strands funds.
 */

const ONE_GWEI = BigInt(1_000_000_000);

describe("paysItsOwnGas", () => {
  it("is true on Arc, where the gas asset IS USDC", () => {
    // findChain("Arc Testnet").nativeCurrency.symbol is literally "USDC".
    expect(paysItsOwnGas("USDC", "USDC")).toBe(true);
  });

  it("is false for an ordinary token on a chain that charges in something else", () => {
    expect(paysItsOwnGas("DONUT", "ETH")).toBe(false);
    expect(paysItsOwnGas("USDC", "ETH")).toBe(false);
  });

  it("is true for the native asset itself", () => {
    expect(paysItsOwnGas("ETH", "ETH")).toBe(true);
  });

  it("compares case-insensitively and refuses to guess from nothing", () => {
    expect(paysItsOwnGas("usdc", "USDC")).toBe(true);
    expect(paysItsOwnGas(undefined, "ETH")).toBe(false);
    expect(paysItsOwnGas("ETH", undefined)).toBe(false);
  });
});

describe("gasReserve", () => {
  it("scales an 18-decimal gas cost into 6-decimal USDC units", () => {
    /*
     * THE ARC CASE. 1 gwei x 65,000 gas x 2 = 1.3e14 wei in the 18-decimal
     * view. The same value in the 6-decimal view is 1.3e14 / 1e12 = 130.
     * Getting this backwards is the 10^12 error CLAUDE.md records twice.
     */
    expect(
      gasReserve({
        gasPrice: ONE_GWEI,
        gasLimit: ERC20_TRANSFER_GAS,
        nativeDecimals: 18,
        assetDecimals: 6,
      }),
    ).toBe(BigInt(130));
  });

  it("does not scale when the two views share decimals", () => {
    expect(
      gasReserve({
        gasPrice: ONE_GWEI,
        gasLimit: NATIVE_TRANSFER_GAS,
        nativeDecimals: 18,
        assetDecimals: 18,
      }),
    ).toBe(ONE_GWEI * NATIVE_TRANSFER_GAS * GAS_SAFETY_MULTIPLIER);
  });

  it("rounds UP, so a sub-unit cost still reserves one unit", () => {
    // Being one base unit short is a failed transaction; being one over is free.
    expect(
      gasReserve({ gasPrice: BigInt(1), gasLimit: BigInt(1), nativeDecimals: 18, assetDecimals: 6 }),
    ).toBe(BigInt(1));
  });

  it("reserves nothing when the gas price could not be read", () => {
    /*
     * "We could not ask" must not become "reserve nothing AND claim it is
     * safe" -- it becomes a plain balance Max, which is the behaviour on every
     * chain where the asset does not pay gas anyway. The wallet still refuses
     * an unaffordable send; this only stops us inventing a reserve from a
     * number we do not have.
     */
    expect(
      gasReserve({ gasPrice: null, gasLimit: ERC20_TRANSFER_GAS, nativeDecimals: 18, assetDecimals: 6 }),
    ).toBe(BigInt(0));
    expect(
      gasReserve({ gasPrice: BigInt(0), gasLimit: ERC20_TRANSFER_GAS, nativeDecimals: 18, assetDecimals: 6 }),
    ).toBe(BigInt(0));
  });
});

describe("maxDepositable", () => {
  const arc = { nativeDecimals: 18, assetDecimals: 6, gasPrice: ONE_GWEI, gasLimit: ERC20_TRANSFER_GAS };

  it("holds gas back when the asset pays for its own transfer", () => {
    // 10 USDC held, 130 base units reserved -> 9.99987 USDC.
    expect(maxDepositable({ held: BigInt(10_000_000), paysGas: true, ...arc })).toBe(
      BigInt(10_000_000 - 130),
    );
  });

  it("offers the whole balance when something else pays the gas", () => {
    // DONUT on Arc: gas is USDC, so a DONUT deposit reserves nothing.
    expect(maxDepositable({ held: BigInt(10_000_000), paysGas: false, ...arc })).toBe(
      BigInt(10_000_000),
    );
  });

  it("never goes negative when the balance is under the reserve", () => {
    // Renders as an empty Max rather than a nonsense one.
    expect(maxDepositable({ held: BigInt(50), paysGas: true, ...arc })).toBe(BigInt(0));
  });

  it("is zero for an empty wallet", () => {
    expect(maxDepositable({ held: BigInt(0), paysGas: true, ...arc })).toBe(BigInt(0));
  });

  it("leaves an amount that is still spendable after the reserve", () => {
    // The property that matters: max + reserve never exceeds the balance, so
    // the transfer the Max produces can actually be paid for.
    const held = BigInt(2_500_000);
    const max = maxDepositable({ held, paysGas: true, ...arc });
    const reserve = gasReserve(arc);
    expect(max + reserve).toBeLessThanOrEqual(held);
  });
});

describe("transferGasLimit", () => {
  it("charges an ERC-20 transfer more than a native send", () => {
    expect(transferGasLimit(true)).toBe(ERC20_TRANSFER_GAS);
    expect(transferGasLimit(false)).toBe(NATIVE_TRANSFER_GAS);
    expect(ERC20_TRANSFER_GAS > NATIVE_TRANSFER_GAS).toBe(true);
  });
});
