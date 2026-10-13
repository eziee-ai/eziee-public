import type { Address, Chain, Hex } from "viem";
import type { DecodedApprovalForRules, DecodedForDisplay } from "./frame/rules";

/**
 * Everything the wallet needs to know about the app it is embedded in.
 *
 * Injected rather than imported so this package depends on nothing else in the
 * repo. BOTH the app and the wallet-frame pages must call `configureWallet`
 * with the same value at module load: the connector and the frame signer each
 * resolve chains, and they must agree.
 */
export type WalletConfig = {
  /** Order is load-bearing: `chains[0]` is the default for a new session. */
  chains: readonly [Chain, ...Chain[]];
  /** WebAuthn `rp.name` and the hidden iframe's title. */
  brand: string;
  /**
   * What a transaction IS, decided from calldata alone. Injected by the app from
   * its protocol registry so this package imports nothing else in the repo. Both
   * must return null for anything they do not positively recognise; a throw or a
   * rejection is treated as null. They may be async: a first-party decoder may need
   * the chain (Rate's swap names a pool, and only the factory can vouch for it). With neither configured, every
   * value-moving request needs a click in the confirm frame.
   */
  decodeAction?: (tx: WalletTx, signer: Address) => DecodedForDisplay | null | Promise<DecodedForDisplay | null>;
  decodeApproval?: (tx: WalletTx) => DecodedApprovalForRules | null | Promise<DecodedApprovalForRules | null>;
};

/** A transaction as the frame hands it to a decoder: normalised, with `value` as a bigint. */
export interface WalletTx {
  chainId: number;
  to: Address;
  data: Hex;
  value: bigint;
}

let current: WalletConfig | null = null;

export function configureWallet(config: WalletConfig): void {
  current = config;
}

export function walletConfig(): WalletConfig {
  if (!current) throw new Error("Wallet is not configured — call configureWallet() first");
  return current;
}

export function walletChains(): readonly [Chain, ...Chain[]] {
  return walletConfig().chains;
}

export function chainById(id: number): Chain {
  const chain = walletChains().find((c) => c.id === id);
  if (!chain) throw new Error(`Chain ${id} is not configured`);
  return chain;
}
