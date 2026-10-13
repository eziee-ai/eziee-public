import { NextResponse } from "next/server";
import { applyCredit, getDb } from "@repo/db";
import { problem, sameOrigin } from "@/lib/server/http";
import { devCreditLimiter } from "@/lib/server/limits";
import { testHooksEnabled } from "@/lib/server/testHooks";
import { currentAddress } from "@/lib/server/session";

/**
 * TEST HOOK. Adds test credit to the signed-in account so an end-to-end test can chat.
 * Answers 404 unless every condition in `testHooksEnabled` holds, so it does not exist where real accounts
 * do. Production has no free grant.
 */
export async function POST(request: Request) {
  if (!testHooksEnabled()) return new NextResponse(null, { status: 404 });
  if (!sameOrigin(request)) return problem(403, "FORBIDDEN", "This request did not come from the app.");
  const address = await currentAddress();
  if (!address) return problem(401, "SIGN_IN_REQUIRED", "Sign in first.");
  const limited = devCreditLimiter.take(`dev-credit:${address}`);
  if (!limited.ok) return problem(429, "RATE_LIMITED", "Too many test top-ups.", { retryAfterSeconds: limited.retryAfterSeconds });
  await applyCredit(await getDb(), { address, amount: 1_000_000n, kind: "adjustment", ref: `e2e:${address}:${Date.now()}`, test: true, meta: { reason: "end-to-end test" } });
  return NextResponse.json({ ok: true });
}
