import { NextResponse } from "next/server";
import { getAddress } from "viem";
import { z } from "zod";
import { getDb, listPaymentTokens, savePaymentToken, type PaymentToken } from "@repo/db";
import { appChains } from "@/lib/chains";
import { isAdmin } from "@/lib/server/admin";
import { parseUsdPrice, paymentTokenRefusal, readTokenFromChain } from "@/lib/server/billing/tokens";
import { problem, readJsonCapped, sameOrigin } from "@/lib/server/http";
import { clientFor } from "@/lib/server/protocolSource";
import { currentAddress } from "@/lib/server/session";

const body = z.object({
  chainId: z.number().int().positive(),
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  /** Dollars of credit one whole token buys, as typed: "0.01". */
  priceUsd: z.string().max(20),
  enabled: z.boolean(),
  faucet: z.boolean(),
});

const view = (token: PaymentToken) => ({ ...token, microusdPerToken: token.microusdPerToken.toString(), updatedAt: token.updatedAt.toISOString() });

async function admin(): Promise<`0x${string}` | NextResponse> {
  const address = await currentAddress();
  if (!address) return problem(401, "SIGN_IN_REQUIRED", "Sign in with your wallet first.");
  if (!isAdmin(address)) return problem(403, "NOT_ADMIN", "This wallet is not an admin of this app.");
  return address;
}

/** Every payment token, enabled or not. Admins only. */
export async function GET() {
  const who = await admin();
  if (who instanceof NextResponse) return who;
  const tokens = await listPaymentTokens(await getDb());
  return NextResponse.json({ tokens: tokens.map(view), chains: appChains.map((chain) => ({ id: chain.id, name: chain.name, testnet: chain.testnet === true })) }, { headers: { "cache-control": "no-store" } });
}

/** Adds a token or changes one. Its symbol and decimals are read from the chain, never taken from the form. */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return problem(403, "FORBIDDEN", "This request did not come from the app.");
  const who = await admin();
  if (who instanceof NextResponse) return who;
  const parsed = body.safeParse(await readJsonCapped(request, 4096));
  if (!parsed.success) return problem(400, "INVALID_REQUEST", "A network, a token address, a price and the two switches are needed.");
  const price = parseUsdPrice(parsed.data.priceUsd);
  if (price === null) return problem(400, "INVALID_PRICE", "The price must be a dollar amount above zero, with at most six decimals.");
  const client = await clientFor(parsed.data.chainId);
  if (!client) return problem(400, "UNSUPPORTED_CHAIN", "That network is not served here.");
  const address = getAddress(parsed.data.address);
  const refusal = paymentTokenRefusal({ chainId: parsed.data.chainId, address, faucet: parsed.data.faucet });
  if (refusal) return problem(400, "TOKEN_REFUSED", refusal);

  let onchain: { symbol: string; decimals: number };
  try {
    onchain = await readTokenFromChain(client, parsed.data.chainId, address);
  } catch (error) {
    return problem(400, "NOT_A_TOKEN", error instanceof Error ? error.message : "That address could not be read as a token.");
  }
  const saved = await savePaymentToken(await getDb(), { chainId: parsed.data.chainId, address, symbol: onchain.symbol, decimals: onchain.decimals, microusdPerToken: price, enabled: parsed.data.enabled, faucet: parsed.data.faucet, updatedBy: who });
  return NextResponse.json({ token: view(saved) }, { headers: { "cache-control": "no-store" } });
}
