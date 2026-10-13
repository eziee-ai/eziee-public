import { BRAND } from "@repo/ui/brand";
import { createRegistry } from "@repo/protocols/registry";
import { VERIFIED_MANIFESTS } from "@repo/protocols/verified";
import { decodeRateLadderApproval, decodeRateWithChain, isUnguardedRateMarketOrder, isUnguardedRateWithdrawal, rateManifest } from "@repo/protocols/rate";
import { configureWallet } from "@repo/wallet/config";
import { createPublicClient, http, type PublicClient } from "viem";
import { appChains } from "./chains";

/**
 * The protocols this BUILD trusts, fixed here at module load. The wallet frame
 * decodes transactions against these bundled manifests and nothing else: no
 * manifest, contract or decoder is ever fetched at runtime (spec §15), so a
 * protocol's server cannot widen what the wallet recognises.
 */
// Verified protocols (guideline §3) are compiled in with the first-party ones. The frame decodes what is in this list and nothing else.
export const protocolRegistry = createRegistry([rateManifest, ...VERIFIED_MANIFESTS]);

// For the one first-party decoder that must read the chain (Rate's swap names a pool, and only
// the factory can vouch for it). Reads only; the frame's CSP allows exactly these RPC origins.
const clients = new Map<number, PublicClient>(appChains.map((chain) => [chain.id, createPublicClient({ chain, transport: http() }) as PublicClient]));

// Imported for its side effect by BOTH the app providers and every wallet-frame
// page, so the connector and the frame signer agree on chains and on decoders.
// A decoded action is still only signed silently under a rule the user made in
// the frame; with no rule, every value-moving request needs a click there.
configureWallet({
  chains: appChains,
  brand: BRAND,
  decodeAction: async (tx, signer) => {
    // A withdrawal with no floor or a far deadline, or a market order with no real slippage bound, is not described
    // as one: the person sees the raw call.
    if (isUnguardedRateWithdrawal(tx) || isUnguardedRateMarketOrder(tx)) return null;
    const declared = protocolRegistry.decode(tx, signer);
    if (declared) return declared;
    const client = clients.get(tx.chainId);
    return client ? decodeRateWithChain(tx, signer, client) : null;
  },
  // A launch coin is never on the reviewed list, so selling one needs Rate's own decoder to name its approval.
  decodeApproval: async (tx) => {
    const declared = protocolRegistry.decodeApproval(tx);
    if (declared) return declared;
    const client = clients.get(tx.chainId);
    return client ? decodeRateLadderApproval(tx, client) : null;
  },
});
