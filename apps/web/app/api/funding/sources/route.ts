import { NextResponse } from "next/server";
import { fundingProblem, fundingRoute } from "@/lib/server/funding";
import { clientIp, problem } from "@/lib/server/http";
import { fundingLimiterByAddress, fundingLimiterByIp } from "@/lib/server/limits";
import { currentAddress } from "@/lib/server/session";

export async function GET(request: Request) {
  const account = await currentAddress();
  if (!account) return problem(401, "SIGN_IN_REQUIRED", "Sign in with your wallet first.");
  for (const limited of [fundingLimiterByAddress.take(account), fundingLimiterByIp.take(clientIp(request))]) {
    if (!limited.ok) return problem(429, "RATE_LIMITED", "Too many requests. Try again shortly.", { retryAfterSeconds: limited.retryAfterSeconds });
  }
  try {
    return NextResponse.json({ sources: await fundingRoute.sources() }, { headers: { "cache-control": "private, max-age=300" } });
  } catch (error) {
    return fundingProblem(error);
  }
}
