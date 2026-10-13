import type { Address, PublicClient } from "viem";
import { decodeAction } from "../manifest/decode";
import type { DecodedAction, ProtocolAdapter, Token, TxRequest } from "../types";
import { rateChains } from "./chains";
import { createGateway, type FetchLike } from "./gateway";
import { rateManifest } from "./manifest";
import { rateActions } from "./actions";
import { decodeRateAddLiquidity } from "./decodeLiquidity";
import { decodeRateSwap } from "./decodeSwap";
import { decodeRateLadderTrade, decodeRateLaunch } from "./decodeLaunchpad";
import { rateReads } from "./reads";

export { rateChains, rateDeployment } from "./chains";
export { RATE_DEPLOYMENTS, RATE_SOURCE_COMMIT } from "./generated/deployments";
export { rateManifest } from "./manifest";
export type { FetchLike } from "./gateway";
export { decodeRateSwap } from "./decodeSwap";
export { decodeRateLadderApproval, decodeRateLadderTrade, decodeRateLaunch } from "./decodeLaunchpad";
export { decodeRateAddLiquidity, isUnguardedRateMarketOrder, isUnguardedRateWithdrawal } from "./decodeLiquidity";

/**
 * Every Rate action that cannot be declared in the manifest, because its calldata names a POOL and only
 * the chain can say what that pool is. Each decoder declines (null) anything that is not its own call.
 */
export async function decodeRateWithChain(tx: TxRequest, signer: Address, client: PublicClient): Promise<DecodedAction | null> {
  return (await decodeRateSwap(tx, signer, client)) ?? (await decodeRateAddLiquidity(tx, signer, client)) ?? (await decodeRateLaunch(tx, signer, client)) ?? (await decodeRateLadderTrade(tx, signer, client));
}

/**
 * Rate, the first-party adapter (spec §6.1). Orders decode from the manifest;
 * the swap and add-liquidity decode through `decodeWithChain`, which proves the pool genuine
 * against the factory before it says anything about the transaction.
 */
export function createRateAdapter(options: { fetch?: FetchLike; timeoutMs?: number } = {}): ProtocolAdapter {
  const gateway = createGateway(options);
  const reads = rateReads(gateway);
  return {
    id: rateManifest.id,
    chains: rateChains,
    contracts(chainId) {
      const entries = Object.entries(rateManifest.contracts[String(chainId)] ?? {});
      return Object.fromEntries(entries.map(([key, contract]) => [key, contract.address])) as Record<string, Address>;
    },
    tokens(chainId): Token[] {
      return (rateManifest.tokens[String(chainId)] ?? []).map((t) => ({ chainId, ...t }));
    },
    actions: rateActions(reads),
    reads,
    decode: (_chainId, tx, signer) => decodeAction(rateManifest, tx, signer),
    decodeWithChain: decodeRateWithChain,
  };
}
