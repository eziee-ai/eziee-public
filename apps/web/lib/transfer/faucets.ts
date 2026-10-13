/**
 * Testnet faucets, keyed by chain id. Copied from iter-monorepo
 * apps/web/lib/errors/insufficientGas.ts (FAUCETS). A faucet is a testnet
 * concept: a chain with no entry gets no link, never a guessed one.
 */
const FAUCETS: Record<number, string> = {
  // Arc pays gas in USDC, so Circle's own testnet faucet IS the gas faucet.
  5042002: "https://faucet.circle.com",
  11155931: "https://faucet.testnet.riselabs.xyz",
};

export function faucetFor(chain: { id: number; testnet?: boolean } | undefined): string | undefined {
  return chain?.testnet ? FAUCETS[chain.id] : undefined;
}
