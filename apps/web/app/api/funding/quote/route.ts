import { NextResponse } from "next/server";
import { z } from "zod";
import { fundingProblem, fundingRoute } from "@/lib/server/funding";
import { clientIp, problem, readJsonCapped, sameOrigin } from "@/lib/server/http";
import { fundingLimiterByAddress, fundingLimiterByIp } from "@/lib/server/limits";
import { currentAddress } from "@/lib/server/session";

const body = z.object({ direction: z.enum(["in", "out"]), chainId: z.number().int().positive(), appAsset: z.string().min(1).max(64), otherAssetId: z.string().min(1).max(200), amount: z.string().min(1).max(78), otherAddress: z.string().min(1).max(128), slippageBps: z.number().int() });

/**
 * A quote creates a deposit address. The account it is for is the signed-in one, never a field of the request:
 * funds coming IN are delivered to it, and funds going OUT are refunded to it.
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return problem(403, "FORBIDDEN", "This request did not come from the app.");
  const account = await currentAddress();
  if (!account) return problem(401, "SIGN_IN_REQUIRED", "Sign in with your wallet first.");
  for (const limited of [fundingLimiterByAddress.take(account), fundingLimiterByIp.take(clientIp(request))]) {
    if (!limited.ok) return problem(429, "RATE_LIMITED", "Too many requests. Try again shortly.", { retryAfterSeconds: limited.retryAfterSeconds });
  }
  const parsed = body.safeParse(await readJsonCapped(request, 8192));
  if (!parsed.success) return problem(400, "INVALID_REQUEST", "The quote request was not valid.");
  try {
    return NextResponse.json({ quote: await fundingRoute.quote({ ...parsed.data, account }) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return fundingProblem(error);
  }
}
