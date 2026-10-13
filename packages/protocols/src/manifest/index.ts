export { callFunction, manifestSchema, parseManifest, resolveArg } from "./schema";
export type { Manifest, ManifestAction, ManifestAmountRef, ManifestCall, ManifestTokenRef } from "./schema";
export { decodeAction, decodeApproval } from "./decode";

import type { Address } from "viem";
import type { Token } from "../types";
import type { Manifest } from "./schema";

/** A manifest's contracts on one chain, by key. One definition, so the server's adapter and the browser's cannot disagree. */
export function manifestContracts(manifest: Manifest, chainId: number): Record<string, Address> {
  return Object.fromEntries(Object.entries(manifest.contracts[String(chainId)] ?? {}).map(([key, contract]) => [key, contract.address])) as Record<string, Address>;
}

/** A manifest's reviewed token list on one chain. */
export function manifestTokens(manifest: Manifest, chainId: number): Token[] {
  return (manifest.tokens[String(chainId)] ?? []).map((token) => ({ chainId, ...token }));
}
