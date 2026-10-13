import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, lt } from "drizzle-orm";
import type { Db } from "./client";
import { authNonces, creditAccounts, sessions, users } from "./schema";

const NONCE_TTL_MS = 5 * 60_000;
const SESSION_TTL_MS = 24 * 3_600_000; // matches the wallet session (spec §9.1)

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const token = (bytes: number) => randomBytes(bytes).toString("base64url");

/** A user and their (empty) credit account. New accounts start at zero: no grant, no promo (spec §14.1). */
export async function ensureUser(db: Db, address: string): Promise<void> {
  await db.insert(users).values({ address }).onConflictDoNothing();
  await db.insert(creditAccounts).values({ address }).onConflictDoNothing();
}

/**
 * A sign-in nonce, bound to the browser that asked for it (`binding` is a hash
 * of that browser's pre-session cookie). Without the binding, script on a
 * compromised page could fetch a nonce for ITS OWN backend session, have the
 * wallet sign it silently, and log in as the user from another machine.
 */
export async function issueNonce(db: Db, input: { binding: string; now: Date }): Promise<string> {
  const nonce = token(32);
  await db.delete(authNonces).where(lt(authNonces.expiresAt, input.now));
  await db.insert(authNonces).values({ nonce, binding: sha256(input.binding), expiresAt: new Date(input.now.getTime() + NONCE_TTL_MS) });
  return nonce;
}

/** True exactly once per nonce, and only from the browser it was issued to, before it expires. One atomic UPDATE. */
export async function consumeNonce(db: Db, input: { nonce: string; binding: string; now: Date }): Promise<boolean> {
  const rows = await db
    .update(authNonces)
    .set({ usedAt: input.now })
    .where(and(eq(authNonces.nonce, input.nonce), eq(authNonces.binding, sha256(input.binding)), isNull(authNonces.usedAt), gt(authNonces.expiresAt, input.now)))
    .returning({ nonce: authNonces.nonce });
  return rows.length === 1;
}

export async function createSession(db: Db, input: { address: string; now: Date }): Promise<{ token: string; expiresAt: Date }> {
  const value = token(32);
  const expiresAt = new Date(input.now.getTime() + SESSION_TTL_MS);
  await db.delete(sessions).where(lt(sessions.expiresAt, input.now));
  await db.insert(sessions).values({ id: sha256(value), address: input.address, expiresAt });
  return { token: value, expiresAt };
}

export async function getSession(db: Db, input: { token: string; now: Date }): Promise<{ address: string; expiresAt: Date } | null> {
  const [row] = await db
    .select({ address: sessions.address, expiresAt: sessions.expiresAt })
    .from(sessions)
    .where(and(eq(sessions.id, sha256(input.token)), gt(sessions.expiresAt, input.now)));
  return row ?? null;
}

export async function deleteSession(db: Db, value: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sha256(value)));
}
