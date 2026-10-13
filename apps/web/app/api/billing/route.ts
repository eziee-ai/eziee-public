import { NextResponse } from "next/server";
import { getAccount, getDb, listLedger } from "@repo/db";
import { appChains } from "@/lib/chains";
import { enabledRails, usdcRail } from "@/lib/server/billing/config";
import { tokenCreditLeftToday, tokenRail } from "@/lib/server/billing/tokens";
import { verifiedUsdc } from "@/lib/server/billing/usdc";
import { problem } from "@/lib/server/http";
import { clientFor } from "@/lib/server/protocolSource";
import { currentAddress } from "@/lib/server/session";

/**
 * The signed-in account's credit: what it can spend, how it can add more, and its recent ledger.
 * The treasury and token addresses come from HERE, from the server's configuration, never from the page's code.
 *
 * `usdcStatus` tells three situations apart, because they need three different sentences on the page:
 *   "off"          nothing is configured;
 *   "ready"        at least one payment network is configured and the chain has vouched for its USDC address;
 *   "unreachable"  it is configured, and no network could be verified just now (an RPC outage, a wrong address).
 */
export async function GET() {
  const address = await currentAddress();
  if (!address) return problem(401, "SIGN_IN_REQUIRED", "Sign in with your wallet first.");
  const db = await getDb();
  const [account, ledger] = await Promise.all([getAccount(db, address), listLedger(db, address)]);

  const usdc = usdcRail();
  const tokens = await tokenRail(db);
  const tokenLeft = tokens && tokens.tokens.length > 0 ? await tokenCreditLeftToday(db, address) : 0n;
  const tokenCap = tokens && tokenLeft < tokens.config.maxPerTopUpMicrousd ? tokenLeft : (tokens?.config.maxPerTopUpMicrousd ?? 0n);
  // A payment network is offered only once the chain has confirmed the configured address really is USDC.
  const chains = (
    await Promise.all(
      Array.from(usdc?.tokens ?? [], async ([chainId, token]) => {
        try {
          const client = await clientFor(chainId);
          if (!client) return null;
          const { decimals } = await verifiedUsdc(client, chainId, token);
          return { chainId, token, decimals, test: appChains.find((chain) => chain.id === chainId)?.testnet === true };
        } catch (error) {
          console.error(`[billing] the USDC token configured for chain ${chainId} could not be verified`, error instanceof Error ? error.message : error);
          return null;
        }
      }),
    )
  ).filter((chain) => chain !== null);

  return NextResponse.json(
    {
      credit: { balanceMicrousd: account.balance.toString(), spendableMicrousd: account.spendable.toString(), heldMicrousd: account.held.toString(), blocked: account.blocked },
      rails: enabledRails(),
      usdcStatus: !usdc ? "off" : chains.length > 0 ? "ready" : "unreachable",
      usdc: usdc && chains.length > 0 ? { treasury: usdc.treasury, confirmations: usdc.confirmations, maxPerTopUpMicrousd: usdc.maxPerTopUpMicrousd.toString(), chains } : null,
      // The operator's own tokens, at the price set on /admin. Their addresses come from the server, like USDC's.
      tokenRail:
        tokens && tokens.tokens.length > 0
          ? { treasury: tokens.config.treasury, confirmations: tokens.config.confirmations, maxPerTopUpMicrousd: tokenCap.toString(), leftTodayMicrousd: tokenLeft.toString(), tokens: tokens.tokens.map((token) => ({ chainId: token.chainId, token: token.address, symbol: token.symbol, decimals: token.decimals, microusdPerToken: token.microusdPerToken.toString(), faucet: token.faucet, test: appChains.find((chain) => chain.id === token.chainId)?.testnet === true })) }
          : null,
      ledger: ledger.map((row) => ({ id: row.id, deltaMicrousd: row.deltaMicrousd.toString(), kind: row.kind, test: row.test, createdAt: row.createdAt.toISOString() })),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
