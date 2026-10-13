import type { Address } from "viem";

/**
 * Obviously fake addresses. Real ones enter this repo only through
 * scripts/vendor-rate.ts; nothing here may be mistaken for a deployment.
 * All-lowercase hex digits with no letters are valid EIP-55 as written.
 */
export const ADDR = {
  router: "0x0000000000000000000000000000000000000101",
  book: "0x0000000000000000000000000000000000000102",
  usdc: "0x0000000000000000000000000000000000000201",
  weth: "0x0000000000000000000000000000000000000202",
  stranger: "0x0000000000000000000000000000000000000999",
  alice: "0x0000000000000000000000000000000000001001",
  mallory: "0x0000000000000000000000000000000000001002",
} as const satisfies Record<string, Address>;

export const FIXTURE_CHAIN_ID = 900001;

/** A deep-cloned, mutable manifest so a test can break one field without leaking into the next. */
export function fixtureManifest(): Record<string, unknown> {
  return structuredClone({
    manifestVersion: 1,
    id: "fixture",
    name: "Fixture DEX",
    version: "1.0.0",
    homepage: "https://example.com",
    chains: [FIXTURE_CHAIN_ID],
    contracts: {
      [FIXTURE_CHAIN_ID]: {
        router: { address: ADDR.router, role: "router", source: "https://example.com/deployments", proxy: { type: "none" } },
        book: { address: ADDR.book, role: "other", source: "https://example.com/deployments", proxy: { type: "none" } },
      },
    },
    tokens: {
      [FIXTURE_CHAIN_ID]: [
        { address: ADDR.usdc, symbol: "USDC", name: "USD Coin", decimals: 6, trust: "canonical" },
        { address: ADDR.weth, symbol: "WETH", name: "Wrapped Ether", decimals: 18, trust: "listed" },
      ],
    },
    actions: {
      swap: {
        title: "Swap",
        spends: true,
        calls: [
          {
            contract: "router",
            abi: "function swapExactIn(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address to, uint256 deadline)",
            spend: [{ token: { arg: "tokenIn" }, amount: { arg: "amountIn" } }],
            receive: { token: { arg: "tokenOut" }, minAmount: { arg: "minOut" } },
            recipient: { arg: "to" },
            deadline: { arg: "deadline" },
          },
        ],
      },
      swapNative: {
        title: "Swap native",
        spends: true,
        calls: [
          {
            contract: "router",
            abi: "function swapNativeIn((address tokenOut, uint256 minOut, address to) params) payable",
            spend: [{ token: "native", amount: "msg.value" }],
            receive: { token: { arg: "params.tokenOut" }, minAmount: { arg: "params.minOut" } },
            recipient: { arg: "params.to" },
          },
        ],
      },
      cancelOrder: {
        title: "Cancel order",
        spends: false,
        calls: [{ contract: "book", abi: "function cancel(uint256 orderId)" }],
      },
    },
  });
}
