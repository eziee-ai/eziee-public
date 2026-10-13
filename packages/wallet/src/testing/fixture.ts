import { defineChain } from "viem";
import { configureWallet, type WalletConfig } from "../config";

export const TEST_CHAIN_A = defineChain({
  id: 900001,
  name: "Test A",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
});

export const TEST_CHAIN_B = defineChain({
  id: 900002,
  name: "Test B",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8546"] } },
});

/** Configure the wallet for a test, optionally with stand-in decoders. */
export function configureTestWallet(decoders: Pick<WalletConfig, "decodeAction" | "decodeApproval"> = {}): void {
  configureWallet({ chains: [TEST_CHAIN_A, TEST_CHAIN_B], brand: "Test Wallet", ...decoders });
}
