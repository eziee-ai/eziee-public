import { cookies } from "next/headers";
import { getAddress, type Address } from "viem";
import { getDb, getSession } from "@repo/db";

/**
 * In production both cookies carry the `__Host-` prefix: the browser then refuses them unless they are Secure,
 * host-only and path "/", so a sibling subdomain (the wallet origin, say) can neither read nor plant one.
 * Development serves plain http on localhost, where a Secure cookie is not reliably accepted, so it is plain there.
 */
const SECURE = process.env.NODE_ENV === "production";
/** The signed-in session cookie: the token only; the server stores its hash. */
export const SESSION_COOKIE = SECURE ? "__Host-wlt_session" : "wlt_session";
/** Set before sign-in so a nonce can be bound to the browser that asked for it. */
export const PRE_SESSION_COOKIE = SECURE ? "__Host-wlt_pre" : "wlt_pre";

export const cookieOptions = (maxAgeSeconds: number) => ({ httpOnly: true, sameSite: "lax" as const, secure: SECURE, path: "/", maxAge: maxAgeSeconds });

/**
 * Expire a cookie. Written as a `set`, not the framework's `delete`: a `__Host-` cookie can only be replaced by a
 * Set-Cookie that is itself Secure with path "/", and a bare deletion is not, so the browser would ignore it.
 */
export function clearCookie(jar: { set(name: string, value: string, options: ReturnType<typeof cookieOptions>): unknown }, name: string): void {
  jar.set(name, "", cookieOptions(0));
}

/** The signed-in wallet address, or null. Every data route starts here, and every query downstream filters by this address. */
export async function currentAddress(): Promise<Address | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const session = await getSession(await getDb(), { token, now: new Date() });
  return session ? getAddress(session.address) : null;
}
