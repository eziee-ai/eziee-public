import { NextResponse } from "next/server";
import { z } from "zod";
import { fundingProblem, fundingRoute } from "@/lib/server/funding";
import { clientIp, problem, readJsonCapped, sameOrigin } from "@/lib/server/http";
import { fundingLimiterByAddress, fundingLimiterByIp } from "@/lib/server/limits";
import { currentAddress } from "@/lib/server/session";

const body = z.object({ txHash: z.string().min(8).max(128).regex(/^[A-Za-z0-9]+$/), depositAddress: z.string().min(2).max(200).regex(/^[A-Za-z0-9._:-]+$/), memo: z.string().max(200).regex(/^[A-Za-z0-9._:-]*$/).optional() });

/** Tells the funding service a deposit was sent, so it starts looking sooner. It moves nothing. */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return problem(403, "FORBIDDEN", "This request did not come from the app.");
  const account = await currentAddress();
  if (!account) return problem(401, "SIGN_IN_REQUIRED", "Sign in with your wallet first.");
  for (const limited of [fundingLimiterByAddress.take(account), fundingLimiterByIp.take(clientIp(request))]) {
    if (!limited.ok) return problem(429, "RATE_LIMITED", "Too many requests. Try again shortly.", { retryAfterSeconds: limited.retryAfterSeconds });
  }
  const parsed = body.safeParse(await readJsonCapped(request, 4096));
  if (!parsed.success) return problem(400, "INVALID_REQUEST", "A transaction hash and a deposit address are needed.");
  try {
    await fundingRoute.submit(parsed.data);
    return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return fundingProblem(error);
  }
}
