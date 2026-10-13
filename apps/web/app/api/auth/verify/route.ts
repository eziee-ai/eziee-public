import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getAddress, isAddress, isHex, verifyMessage } from "viem";
import { z } from "zod";
import { BRAND } from "@repo/ui/brand";
import { consumeNonce, createSession, ensureUser, getDb } from "@repo/db";
import { isSignInMessage, signInNonce } from "@repo/wallet/signIn";
import { clientIp, problem, readJsonBody, sameOrigin } from "@/lib/server/http";
import { authLimiter } from "@/lib/server/limits";
import { clearCookie, cookieOptions, PRE_SESSION_COOKIE, SESSION_COOKIE } from "@/lib/server/session";

const body = z.object({
  address: z.string().refine((v) => isAddress(v, { strict: false })),
  message: z.string().max(400),
  signature: z.string().refine((v) => isHex(v) && v.length === 132, "expected a 65-byte signature"),
});

/**
 * Step 2 of sign-in. Order matters: the message must be exactly this app's
 * template for the claimed address and freshly dated; THEN the nonce is consumed
 * (single use, this browser only); THEN the signature is checked. A request that
 * fails any step gets the same answer, so none of them is an oracle.
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return problem(403, "FORBIDDEN", "This request did not come from the app.");
  const limited = authLimiter.take(`verify:${clientIp(request)}`);
  if (!limited.ok) return problem(429, "RATE_LIMITED", "Too many sign-in attempts. Try again shortly.", { retryAfterSeconds: limited.retryAfterSeconds });

  // An address, a signature and a short sign-in message. Anyone can reach this route, so a large body is refused unread.
  const read = await readJsonBody(request, 16_384);
  const parsed = body.safeParse(read.ok ? read.value : null);
  const refused = () => problem(401, "SIGN_IN_FAILED", "Sign-in could not be verified. Try again.");
  if (!parsed.success) return refused();

  const address = getAddress(parsed.data.address);
  const now = new Date();
  // `sameOrigin` has just established that this Origin is this site, so it is what the message must name.
  const origin = request.headers.get("origin") ?? "";
  if (!isSignInMessage(parsed.data.message, { brand: BRAND, account: address, origin, now: now.getTime() })) return refused();
  const nonce = signInNonce(parsed.data.message);
  const jar = await cookies();
  const binding = jar.get(PRE_SESSION_COOKIE)?.value;
  if (!nonce || !binding) return refused();

  const db = await getDb();
  if (!(await consumeNonce(db, { nonce, binding, now }))) return refused();
  const valid = await verifyMessage({ address, message: parsed.data.message, signature: parsed.data.signature as `0x${string}` }).catch(() => false);
  if (!valid) return refused();

  await ensureUser(db, address);
  const session = await createSession(db, { address, now });
  jar.set(SESSION_COOKIE, session.token, cookieOptions(24 * 3600));
  clearCookie(jar, PRE_SESSION_COOKIE);
  return NextResponse.json({ address, expiresAt: session.expiresAt.toISOString() }, { headers: { "cache-control": "no-store" } });
}
