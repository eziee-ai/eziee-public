import { createPublicClient, http, type PublicClient } from "viem";
import { createRateAdapter } from "@repo/protocols/rate";
import { VERIFIED_MANIFESTS } from "@repo/protocols/verified";
import { appChains } from "@/lib/chains";
import { createProtocolSource } from "./protocols";

/** This deployment's protocols: Rate, first-party, and every Verified protocol whose server is configured. */
export const protocolSource = createProtocolSource({ firstParty: [createRateAdapter()], verified: VERIFIED_MANIFESTS, chains: appChains });

/** `RPC_URL_<chainId>`: https, or plain http to this machine only (a local node, a test). Anything else is ignored, loudly. */
export function rpcOverride(chainId: number, env: Record<string, string | undefined> = process.env): string | undefined {
  const raw = env[`RPC_URL_${chainId}`];
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) return url.href;
  } catch {
    // falls through
  }
  console.error(`[rpc] RPC_URL_${chainId} is not an https URL (or http to this machine); it is ignored`);
  return undefined;
}

const clients = new Map<number, Promise<PublicClient | null>>();

/**
 * A read-only client for a network this app serves, or null.
 *
 * `RPC_URL_<chainId>` replaces the chain's public endpoint for the SERVER's reads (the model's tools, deposit
 * checks). Public endpoints are rate limited and shared; a deployment that takes payments should use its own.
 *
 * An override is believed only once it has answered as the right chain, and that is awaited BEFORE the first read
 * goes through it. One that answers as another chain yields null: the network is then not served, rather than
 * quietly read from a public endpoint the operator chose not to use. One that cannot be reached at all is handed
 * back as it is; its reads will fail on their own, and the deposit check verifies the chain again regardless.
 */
export function clientFor(chainId: number): Promise<PublicClient | null> {
  const chain = appChains.find((c) => c.id === chainId);
  if (!chain) return Promise.resolve(null);
  let pending = clients.get(chainId);
  if (!pending) {
    const override = rpcOverride(chainId);
    // Server reads sit inside a person's request: fail in seconds, not in viem's default of four tries at ten each.
    const client = createPublicClient({ chain, transport: http(override, { timeout: 8_000, retryCount: 1 }) }) as PublicClient;
    pending = !override
      ? Promise.resolve(client)
      : client.getChainId().then(
          (actual) => {
            if (actual === chainId) return client;
            console.error(`[rpc] RPC_URL_${chainId} answers as chain ${actual}; chain ${chainId} is not served until that is fixed`);
            return null;
          },
          () => {
            clients.delete(chainId); // not verified yet: check again on the next request
            return client;
          },
        );
    clients.set(chainId, pending);
  }
  return pending;
}
