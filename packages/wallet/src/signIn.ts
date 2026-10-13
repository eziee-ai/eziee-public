import { getAddress, type Address } from "viem";

/**
 * The sign-in message (spec §9.1), in a module with no other imports so the
 * SERVER can build and check the very same template the wallet frame signs
 * silently. One definition, two callers, no drift.
 */

const SIGN_IN_MAX_AGE_MS = 10 * 60 * 1000;
// A little room for a client clock that runs ahead; a message dated further into the future is refused.
const SIGN_IN_FUTURE_MS = 60 * 1000;

/** `origin` is the site being signed in to, exactly as the browser names it: scheme, host and port, no path. */
export function signInMessage(input: { brand: string; address: Address; origin: string; nonce: string; issued: string }): string {
  return `${input.brand} sign-in\nAddress: ${input.address}\nURI: ${input.origin}\nNonce: ${input.nonce}\nIssued: ${input.issued}`;
}

/**
 * Exactly the template, for exactly this account, for exactly this site, issued in the last ten minutes.
 * Nothing else is a sign-in.
 *
 * `origin` is what the CHECKER knows the site to be, never something read from the message: the wallet frame
 * passes the origin of the window that asked, and the server passes its own. A signature made for one site is
 * therefore not a sign-in anywhere else, even somewhere that uses the same brand name.
 *
 * What this does NOT protect, by design: script on a compromised app origin can ask for this signature and use
 * it to sign in as the user elsewhere. The backend must make each nonce single-use, short-lived, and bound to
 * the browser session that requested it (spec §9.1); the frame cannot do that part.
 */
export function isSignInMessage(text: string, ctx: { brand: string; account: Address; origin: string; now: number }): boolean {
  const lines = text.split("\n");
  if (lines.length !== 5) return false;
  const [title, address, uri, nonce, issued] = lines as [string, string, string, string, string];
  if (title !== `${ctx.brand} sign-in`) return false;
  if (address !== `Address: ${getAddress(ctx.account)}`) return false;
  if (!/^https?:\/\/[^\s/]+$/.test(ctx.origin) || uri !== `URI: ${ctx.origin}`) return false;
  if (!/^Nonce: [A-Za-z0-9_-]{16,64}$/.test(nonce)) return false;
  const stamp = /^Issued: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)$/.exec(issued)?.[1];
  if (!stamp) return false;
  const at = Date.parse(stamp);
  return Number.isFinite(at) && at <= ctx.now + SIGN_IN_FUTURE_MS && ctx.now - at <= SIGN_IN_MAX_AGE_MS;
}

/** The nonce inside a message that `isSignInMessage` has already accepted. */
export function signInNonce(text: string): string | null {
  return /^Nonce: ([A-Za-z0-9_-]{16,64})$/m.exec(text)?.[1] ?? null;
}
