import { defineChain, type Chain } from "viem";

export const riseTestnet = /*#__PURE__*/ defineChain({
  id: 11155931,
  name: "RISE Testnet",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://testnet.riselabs.xyz"] } },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://explorer.testnet.riselabs.xyz/" },
  },
  testnet: true,
  /**
   * Without this, viem refuses EVERY batched read on RISE with
   * `ChainDoesNotSupportContract: Chain "RISE Testnet" does not support contract
   * "multicall3"` — and since this is the definition `createConfig({ chains })`
   * takes, that applied app-wide, not just to one caller.
   *
   * It read as absence rather than as an error: a `multicall` rejects, whatever
   * called it falls into its catch, and the feature renders empty. The quote
   * picker showed no quotes at all this way while the contract was answering
   * fine, which is how it was found.
   *
   * The two sibling RISE definitions above already carried this address. This
   * one — the one that actually reaches wagmi — never did. Verified deployed:
   * `cast code` returns 6.5KB of bytecode, and a multicall against it resolves
   * `enabledQuoteTokens` + symbol + decimals in one round trip.
   */
  contracts: {
    multicall3: {
      address: "0x33f6552F37772e42A31d03233812d2dC6afd2f97",
      blockCreated: 457931,
    },
  },
});

/**
 * Arc Testnet. Two things here are NOT copy-paste from the chains above.
 *
 * **`nativeCurrency` is USDC at 18 decimals.** Arc's gas asset IS USDC, and the native
 * view is 18 decimals while the USDC ERC-20 at
 * 0x3600000000000000000000000000000000000000 is 6 — the SAME pool of funds through two
 * interfaces, not two assets. Both numbers are correct and neither is a typo for the
 * other. Anything that reads a native balance and an ERC-20 USDC balance and shows both
 * is double-counting one balance; anything that formats the 18-decimal native value with
 * the token list's 6 decimals is off by 10^12.
 *
 * **multicall3 is a GENESIS PREDEPLOY here.** Verified on chain: 3808 bytes of code at
 * block 0, against an archive-capable node (our own engine correctly returns `0x` at
 * block 0 and code at head, so the historical reads are real). Pinned from the first
 * commit deliberately — RISE shipped without this and viem then refused EVERY batched
 * read app-wide with `ChainDoesNotSupportContract`, which reads as empty UI rather than
 * as an error. See the comment on riseTestnet's own contracts block.
 */
export const arcTestnet = /*#__PURE__*/ defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.network"] } },
  blockExplorers: {
    default: { name: "Arcscan", url: "https://testnet.arcscan.app" },
  },
  testnet: true,
  contracts: {
    multicall3: {
      address: "0xcA11bde05977b3631167028862bE2a173976CA11",
      blockCreated: 0,
    },
  },
});

/**
 * Monad Testnet. Rate's launchpad runs here: coins launched on it trade on their sell ladder through LadderBuyer.
 * multicall3 is at the canonical address (verified with `cast code` against this RPC); its creation block is not
 * pinned, so viem simply does not use it for reads older than it, which this app never makes.
 */
export const monadTestnet = /*#__PURE__*/ defineChain({
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: ["https://testnet-rpc.monad.xyz"] } },
  blockExplorers: {
    default: { name: "Monad Explorer", url: "https://testnet.monadexplorer.com" },
  },
  testnet: true,
  contracts: {
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
  },
});

// Order is load-bearing: appChains[0] is the default chain for a new session.
export const appChains = [arcTestnet, riseTestnet, monadTestnet] as const satisfies readonly [Chain, ...Chain[]];
