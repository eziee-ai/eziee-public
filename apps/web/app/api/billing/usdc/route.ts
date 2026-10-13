import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@repo/db";
import { appChains } from "@/lib/chains";
import { usdcRail } from "@/lib/server/billing/config";
import { creditUsdcDeposit } from "@/lib/server/billing/usdc";
import { clientIp, problem, readJsonCapped, sameOrigin } from "@/lib/server/http";
import { topUpLimiterByAddress, topUpLimiterByIp } from "@/lib/server/limits";
import { clientFor } from "@/lib/server/protocolSource";
import { currentAddress } from "@/lib/server/session";

const body = z.object({ chainId: z.number().int().positive(), hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) });

/**
 * "I sent USDC to the top-up address; here is the transaction." The server checks the chain and credits what it
 * finds there (see `creditUsdcDeposit`). Safe to call again and again: a deposit is credited once.
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return problem(403, "FORBIDDEN", "This request did not come from the app.");
  const address = await currentAddress();
  if (!address) return problem(401, "SIGN_IN_REQUIRED", "Sign in with your wallet first.");
  for (const limited of [topUpLimiterByAddress.take(address), topUpLimiterByIp.take(clientIp(request))]) {
    if (!limited.ok) return problem(429, "RATE_LIMITED", "Too many requests. Try again shortly.", { retryAfterSeconds: limited.retryAfterSeconds });
  }
  const config = usdcRail();
  if (!config) return problem(404, "RAIL_DISABLED", "Adding credit with USDC is not switched on here.");
  const parsed = body.safeParse(await readJsonCapped(request, 4096));
  if (!parsed.success) return problem(400, "INVALID_REQUEST", "A chain id and a transaction hash are needed.");
  const client = await clientFor(parsed.data.chainId);
  const chain = appChains.find((candidate) => candidate.id === parsed.data.chainId);
  if (!client || !chain) return problem(400, "UNSUPPORTED_CHAIN", "That network is not served here.");

  try {
    const result = await creditUsdcDeposit({ db: await getDb(), address, chainId: chain.id, hash: parsed.data.hash as `0x${string}`, client, config, test: chain.testnet === true });
    return NextResponse.json(result.status === "credited" ? { status: result.status, creditedMicrousd: result.creditedMicrousd.toString() } : result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("[billing] a USDC deposit could not be checked", error);
    return problem(503, "TEMPORARILY_UNAVAILABLE", "The deposit could not be checked just now. Nothing is lost: try again in a minute.");
  }
}
