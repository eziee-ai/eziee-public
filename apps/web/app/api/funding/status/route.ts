import { NextResponse } from "next/server";
import { cleanReason, fundingProblem, fundingRoute } from "@/lib/server/funding";
import { clientIp, problem } from "@/lib/server/http";
import { fundingLimiterByAddress, fundingLimiterByIp } from "@/lib/server/limits";
import { currentAddress } from "@/lib/server/session";

const ADDRESS = /^[A-Za-z0-9._:-]{2,200}$/;

export async function GET(request: Request) {
  const account = await currentAddress();
  if (!account) return problem(401, "SIGN_IN_REQUIRED", "Sign in with your wallet first.");
  for (const limited of [fundingLimiterByAddress.take(account), fundingLimiterByIp.take(clientIp(request))]) {
    if (!limited.ok) return problem(429, "RATE_LIMITED", "Too many requests. Try again shortly.", { retryAfterSeconds: limited.retryAfterSeconds });
  }
  const params = new URL(request.url).searchParams;
  const depositAddress = params.get("depositAddress") ?? "";
  const depositMemo = params.get("depositMemo") ?? undefined;
  if (!ADDRESS.test(depositAddress) || (depositMemo !== undefined && !ADDRESS.test(depositMemo))) return problem(400, "INVALID_REQUEST", "A deposit address is needed.");
  try {
    const result = await fundingRoute.status({ depositAddress, ...(depositMemo ? { depositMemo } : {}) });
    return NextResponse.json({ status: result.status, refundReason: cleanReason(result.refundReason) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return fundingProblem(error);
  }
}
