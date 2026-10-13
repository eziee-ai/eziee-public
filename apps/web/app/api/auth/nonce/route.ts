import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getDb, issueNonce } from "@repo/db";
import { clientIp, problem, sameOrigin } from "@/lib/server/http";
import { authLimiter } from "@/lib/server/limits";
import { cookieOptions, PRE_SESSION_COOKIE } from "@/lib/server/session";

/**
 * Step 1 of sign-in (spec §9.1): a single-use nonce, good for five minutes, and
 * only in THIS browser. The binding is a random pre-session cookie: script that
 * steals a nonce, or asks for one from its own machine, cannot redeem it here.
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return problem(403, "FORBIDDEN", "This request did not come from the app.");
  const limited = authLimiter.take(`nonce:${clientIp(request)}`);
  if (!limited.ok) return problem(429, "RATE_LIMITED", "Too many sign-in attempts. Try again shortly.", { retryAfterSeconds: limited.retryAfterSeconds });

  const jar = await cookies();
  let binding = jar.get(PRE_SESSION_COOKIE)?.value;
  if (!binding || !/^[A-Za-z0-9_-]{43}$/.test(binding)) {
    binding = randomBytes(32).toString("base64url");
    jar.set(PRE_SESSION_COOKIE, binding, cookieOptions(10 * 60));
  }
  const nonce = await issueNonce(await getDb(), { binding, now: new Date() });
  return NextResponse.json({ nonce }, { headers: { "cache-control": "no-store" } });
}
