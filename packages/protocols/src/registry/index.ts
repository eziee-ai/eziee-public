import type { Address } from "viem";
import { ProtocolError } from "../errors";
import { decodeAction, decodeApproval } from "../manifest/decode";
import { parseManifest, type Manifest } from "../manifest/schema";
import type { DecodedAction, DecodedApproval, TxRequest } from "../types";

export interface RegisteredContract {
  protocol: string;
  key: string;
  role: string;
}

export interface Registry {
  all(): Manifest[];
  get(id: string): Manifest | undefined;
  forChain(chainId: number): Manifest[];
  /** Lowercased address to owner, for every contract any protocol registers on the chain. */
  contracts(chainId: number): Map<string, RegisteredContract>;
  decode(tx: TxRequest, signer: Address): DecodedAction | null;
  decodeApproval(tx: TxRequest): DecodedApproval | null;
}

/**
 * The set of manifests this build trusts.
 *
 * INVARIANT (spec §15): the set is fixed when the registry is created. Nothing
 * adds a contract, token or decoder afterwards, so a response from a protocol's
 * server can never widen what the wallet recognises.
 *
 * Collisions are refused rather than resolved: if two protocols claimed one
 * address, "which protocol is this transaction for" would depend on load order.
 */
export function createRegistry(inputs: readonly unknown[]): Registry {
  const manifests = inputs.map((input) => parseManifest(input));
  const byId = new Map<string, Manifest>();
  const byChain = new Map<number, Map<string, RegisteredContract>>();
  const tokensByChain = new Map<number, Set<string>>();

  for (const manifest of manifests) {
    if (byId.has(manifest.id)) throw new ProtocolError("INVALID_MANIFEST", `duplicate protocol id "${manifest.id}"`);
    byId.set(manifest.id, manifest);
    for (const [chainId, tokens] of Object.entries(manifest.tokens)) {
      const set = tokensByChain.get(Number(chainId)) ?? new Set<string>();
      for (const token of tokens) set.add(token.address.toLowerCase());
      tokensByChain.set(Number(chainId), set);
    }
  }

  for (const manifest of manifests) {
    for (const [chainKey, contracts] of Object.entries(manifest.contracts)) {
      const chainId = Number(chainKey);
      const map = byChain.get(chainId) ?? new Map<string, RegisteredContract>();
      for (const [key, contract] of Object.entries(contracts)) {
        const address = contract.address.toLowerCase();
        const owner = map.get(address);
        if (owner) throw new ProtocolError("INVALID_MANIFEST", `${contract.address} on chain ${chainId} is claimed by both "${owner.protocol}" and "${manifest.id}"`);
        // A token registered as a protocol contract would make its transfers look like protocol calls.
        if (tokensByChain.get(chainId)?.has(address)) throw new ProtocolError("INVALID_MANIFEST", `${contract.address} on chain ${chainId} is registered as a contract by "${manifest.id}" but is a listed token`);
        map.set(address, { protocol: manifest.id, key, role: contract.role });
      }
      byChain.set(chainId, map);
    }
  }

  const ownerOf = (chainId: number, to: string): Manifest | undefined => {
    const owner = byChain.get(chainId)?.get(to.toLowerCase());
    return owner ? byId.get(owner.protocol) : undefined;
  };

  return {
    all: () => [...manifests],
    get: (id) => byId.get(id),
    forChain: (chainId) => manifests.filter((m) => m.chains.includes(chainId)),
    contracts: (chainId) => new Map(byChain.get(chainId) ?? []),
    decode(tx, signer) {
      const manifest = ownerOf(tx.chainId, tx.to);
      return manifest ? decodeAction(manifest, tx, signer) : null;
    },
    decodeApproval(tx) {
      for (const manifest of manifests) {
        const approval = decodeApproval(manifest, tx);
        if (approval) return approval;
      }
      return null;
    },
  };
}
