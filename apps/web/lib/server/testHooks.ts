import { applyCredit, getAccount, type Db } from "@repo/db";

/**
 * Whether this server is a developer's own machine: not a production build, not a hosted deployment (Vercel sets
 * VERCEL on every one, previews included), and on the embedded database (with DATABASE_URL set, the ledger may be
 * a real one). Every local-only switch below requires all of it, so free or test credit can never reach a ledger
 * real people pay into.
 */
function localOnly(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  if (process.env.VERCEL || process.env.VERCEL_ENV) return false;
  if (process.env.DATABASE_URL) return false;
  return true;
}

/**
 * End-to-end test hooks: a scripted model, a test credit route, looser rate limits.
 * On only when the server was started with E2E_TEST_HOOKS=1 AND it is local (see `localOnly`).
 */
export function testHooksEnabled(): boolean {
  return process.env.E2E_TEST_HOOKS === "1" && localOnly();
}

/**
 * Free credit for local development: the REAL model, with the account kept topped up so a developer never meets
 * the out-of-credit wall. On only when the server was started with DEV_FREE_CREDIT=1 AND it is local.
 * Billing still runs (holds, settlement, the ledger); only the balance is refilled, as test credit.
 */
export function freeCreditEnabled(): boolean {
  return process.env.DEV_FREE_CREDIT === "1" && localOnly();
}

const REFILL_BELOW = 10_000_000n; // $10
const REFILL_TO = 100_000_000n; // $100

/** Under free credit, tops the account back up to $100 when it falls below $10. Does nothing otherwise. */
export async function refillFreeCredit(db: Db, address: string): Promise<void> {
  if (!freeCreditEnabled()) return;
  const account = await getAccount(db, address);
  if (account.blocked || account.spendable >= REFILL_BELOW) return;
  await applyCredit(db, { address, amount: REFILL_TO - account.spendable, kind: "adjustment", ref: `dev-free:${address}:${Date.now()}:${crypto.randomUUID()}`, test: true, meta: { reason: "DEV_FREE_CREDIT" } });
}
