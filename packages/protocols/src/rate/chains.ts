import { defineChain, type Chain } from "viem";
import { RATE_DEPLOYMENTS } from "./generated/deployments";

export type RateChainId = (typeof RATE_DEPLOYMENTS)[keyof typeof RATE_DEPLOYMENTS]["chainId"];

/** viem chains built from the vendored data, so the adapter and its addresses can never disagree about a chain. */
export const rateChains: readonly Chain[] = Object.values(RATE_DEPLOYMENTS).map((c) =>
  defineChain({
    id: c.chainId,
    name: c.name,
    nativeCurrency: c.nativeCurrency,
    rpcUrls: { default: { http: [c.rpcUrl] } },
    blockExplorers: { default: { name: "Explorer", url: c.explorerUrl } },
    testnet: true,
  }),
);

export function rateDeployment(chainId: number) {
  return Object.values(RATE_DEPLOYMENTS).find((c) => c.chainId === chainId);
}
