import { NextResponse } from "next/server";
import { formatUsd } from "@repo/agent/pricing";
import { getAddress } from "viem";
import { z } from "zod";
import { getDb } from "@repo/db";
import { appChains } from "@/lib/chains";
import { tokenCreditLeftToday, tokenDailyLimit, tokenRail } from "@/lib/server/billing/tokens";
import { creditTokenDeposit } from "@/lib/server/billing/usdc";
import { clientIp, problem, readJsonCapped, sameOrigin } from "@/lib/server/http";
import { topUpLimiterByAddress, topUpLimiterByIp } from "@/lib/server/limits";
import { clientFor } from "@/lib/server/protocolSource";
import { currentAddress } from "@/lib/server/session";

const body = z.object({ chainId: z.number().int().positive(), token: z.string().regex(/^0x[0-9a-fA-F]{40}$/), hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) });

/**
 * "I sent one of the operator's tokens to the top-up address; here is the transaction." The same checks as USDC,
 * at the price the operator set. The price is read when the deposit is checked, not when it was sent.
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return problem(403, "FORBIDDEN", "This request did not come from the app.");
  const address = await currentAddress();
  if (!address) return problem(401, "SIGN_IN_REQUIRED", "Sign in with your wallet first.");
  for (const limited of [topUpLimiterByAddress.take(address), topUpLimiterByIp.take(clientIp(request))]) {
    if (!limited.ok) return problem(429, "RATE_LIMITED", "Too many requests. Try again shortly.", { retryAfterSeconds: limited.retryAfterSeconds });
  }
  const parsed = body.safeParse(await readJsonCapped(request, 4096));
  if (!parsed.success) return problem(400, "INVALID_REQUEST", "A chain id, a token and a transaction hash are needed.");
  const db = await getDb();
  // Only a token the rail offers right now: enabled, on a chain where credit may be bought.
  const rail = await tokenRail(db);
  const wanted = getAddress(parsed.data.token);
  const token = rail?.tokens.find((candidate) => candidate.chainId === parsed.data.chainId && candidate.address === wanted);
  if (!rail || !token) return problem(404, "RAIL_DISABLED", "Credit cannot be bought with that token here.");
  const client = await clientFor(parsed.data.chainId);
  const chain = appChains.find((candidate) => candidate.id === parsed.data.chainId);
  if (!client || !chain) return problem(400, "UNSUPPORTED_CHAIN", "That network is not served here.");

  // The tighter of the per-top-up cap and what is left of today's: these tokens come free from a faucet.
  const left = await tokenCreditLeftToday(db, address);
  const capped = left < rail.config.maxPerTopUpMicrousd;
  try {
    const result = await creditTokenDeposit({
      db,
      address,
      chainId: chain.id,
      hash: parsed.data.hash as `0x${string}`,
      client,
      limit: tokenDailyLimit(),
      config: capped ? { ...rail.config, maxPerTopUpMicrousd: left } : rail.config,
      capMessage: capped ? `That deposit is above what this account can still buy with the app's tokens today, ${formatUsd(left)}. Nothing was credited. Try a smaller amount tomorrow, or contact the operator of this app with the transaction hash.` : undefined,
      token: { address: getAddress(token.address), symbol: token.symbol, kind: "topup_token", value: async () => ({ decimals: token.decimals, microusdPerToken: token.microusdPerToken }) },
      test: chain.testnet === true,
    });
    return NextResponse.json(result.status === "credited" ? { status: result.status, creditedMicrousd: result.creditedMicrousd.toString() } : result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("[billing] a token deposit could not be checked", error);
    return problem(503, "TEMPORARILY_UNAVAILABLE", "The deposit could not be checked just now. Nothing is lost: try again in a minute.");
  }
}
