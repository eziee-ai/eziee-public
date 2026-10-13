import { and, desc, eq, gte, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "./client";
import { creditAccounts, creditHolds, creditLedger } from "./schema";

/**
 * The prepaid credit ledger (spec §14.1, §14.2).
 *
 * INVARIANT: an account's `balance` equals the sum of its ledger rows. Every
 *   balance change and its ledger row are written in ONE transaction.
 * INVARIANT: `held <= max(balance, 0)`, enforced by a CHECK constraint too.
 * INVARIANT: a `ref` credits at most once. A replayed webhook or a
 *   re-submitted transaction hash is a no-op, decided by a unique index.
 * INVARIANT: usage never takes a balance negative: a settle charges at most
 *   the hold that was reserved for it. Only a refund or chargeback can, and
 *   that blocks the account until it is settled.
 *
 * Every read-then-write locks the account row (`FOR UPDATE`), so concurrent
 * requests for one account serialise instead of both passing a check.
 */

export const CREDIT_KINDS = ["topup_usdc", "topup_card", "topup_token", "usage", "refund", "adjustment"] as const;
export type CreditKind = (typeof CREDIT_KINDS)[number];

export interface Account {
  balance: bigint;
  held: bigint;
  /** What can be spent now: never negative, zero when blocked. */
  spendable: bigint;
  blocked: boolean;
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function lockAccount(tx: Tx, address: string) {
  const [row] = await tx.select().from(creditAccounts).where(eq(creditAccounts.address, address)).for("update");
  if (!row) throw new Error(`no credit account for ${address}`);
  return row;
}

const view = (row: { balanceMicrousd: bigint; heldMicrousd: bigint; blocked: boolean }): Account => {
  const free = row.balanceMicrousd - row.heldMicrousd;
  return { balance: row.balanceMicrousd, held: row.heldMicrousd, blocked: row.blocked, spendable: row.blocked || free < 0n ? 0n : free };
};

export async function getAccount(db: Db, address: string): Promise<Account> {
  const [row] = await db.select().from(creditAccounts).where(eq(creditAccounts.address, address));
  if (!row) throw new Error(`no credit account for ${address}`);
  return view(row);
}

/** For tests and audits: the ledger's own opinion of the balance. */
export async function ledgerSum(db: Db, address: string): Promise<bigint> {
  const [row] = await db.select({ total: sql<string>`COALESCE(SUM(${creditLedger.deltaMicrousd}), 0)` }).from(creditLedger).where(eq(creditLedger.address, address));
  return BigInt(row?.total ?? "0");
}

export interface LedgerRow {
  id: string;
  deltaMicrousd: bigint;
  kind: string;
  test: boolean;
  createdAt: Date;
}

/** An account's most recent ledger rows, newest first: what was added, what was spent. Never another account's. */
/** What an account was credited of one kind since a moment: the input to a cap per day. */
export async function creditedSince(db: Db | Tx, input: { address: string; kind: CreditKind; since: Date }): Promise<bigint> {
  const [row] = await db
    .select({ total: sql<string>`COALESCE(SUM(${creditLedger.deltaMicrousd}), 0)` })
    .from(creditLedger)
    .where(and(eq(creditLedger.address, input.address), eq(creditLedger.kind, input.kind), gte(creditLedger.createdAt, input.since)));
  return BigInt(row?.total ?? "0");
}

export async function listLedger(db: Db, address: string, limit = 25): Promise<LedgerRow[]> {
  return db
    .select({ id: creditLedger.id, deltaMicrousd: creditLedger.deltaMicrousd, kind: creditLedger.kind, test: creditLedger.test, createdAt: creditLedger.createdAt })
    .from(creditLedger)
    .where(eq(creditLedger.address, address))
    .orderBy(desc(creditLedger.createdAt), desc(creditLedger.id)) // rows written in one transaction share a timestamp; the id keeps their order stable
    .limit(Math.min(Math.max(limit, 1), 100));
}

/** Thrown by `applyCredit` when a credit would take its kind past the account's limit; nothing was written. */
export class CreditLimitError extends Error {
  constructor(readonly leftMicrousd: bigint) {
    super("credit limit reached");
  }
}

/**
 * Add (or, for a refund, remove) credit. Returns false when this `ref` was already applied.
 *
 * With `limit`, credit of this kind since `limit.since` may not pass `limit.maxMicrousd`. It is checked under the
 * account's row lock, so two deposits checked at the same moment cannot both fit under it.
 */
export async function applyCredit(db: Db, input: { address: string; amount: bigint; kind: CreditKind; ref: string; test?: boolean; meta?: unknown; limit?: { since: Date; maxMicrousd: bigint } }): Promise<boolean> {
  if (input.amount === 0n) throw new Error("a ledger row must change the balance");
  if (!CREDIT_KINDS.includes(input.kind)) throw new Error(`unknown ledger kind ${String(input.kind)}`);
  return db.transaction(async (tx) => {
    const account = await lockAccount(tx, input.address);
    if (input.limit) {
      const [already] = await tx.select({ id: creditLedger.id }).from(creditLedger).where(eq(creditLedger.ref, input.ref));
      if (already) return false;
      const used = await creditedSince(tx, { address: input.address, kind: input.kind, since: input.limit.since });
      if (used + input.amount > input.limit.maxMicrousd) throw new CreditLimitError(input.limit.maxMicrousd > used ? input.limit.maxMicrousd - used : 0n);
    }
    const inserted = await tx
      .insert(creditLedger)
      .values({ address: input.address, deltaMicrousd: input.amount, kind: input.kind, ref: input.ref, test: input.test ?? false, meta: input.meta ?? null })
      .onConflictDoNothing({ target: creditLedger.ref })
      .returning({ id: creditLedger.id });
    if (inserted.length === 0) return false;
    const balance = account.balanceMicrousd + input.amount;
    // A balance driven negative (a chargeback after the credit was spent) blocks the account (spec §14.3).
    // Holds cannot exceed a non-positive balance, so they are dropped with it.
    await tx
      .update(creditAccounts)
      .set({ balanceMicrousd: balance, blocked: account.blocked || balance < 0n, heldMicrousd: balance < account.heldMicrousd ? (balance > 0n ? balance : 0n) : account.heldMicrousd })
      .where(eq(creditAccounts.address, input.address));
    return true;
  });
}

export type HoldResult = { ok: true; holdId: string } | { ok: false; reason: "insufficient" | "blocked"; spendable: bigint };

/** Reserve credit for a request BEFORE the model is called (spec §14.2 step 1). */
export async function placeHold(db: Db, address: string, amount: bigint): Promise<HoldResult> {
  if (amount <= 0n) throw new Error("a hold must be positive");
  return db.transaction(async (tx) => {
    const account = await lockAccount(tx, address);
    const current = view(account);
    if (account.blocked) return { ok: false, reason: "blocked", spendable: 0n } as const;
    if (current.spendable < amount) return { ok: false, reason: "insufficient", spendable: current.spendable } as const;
    await tx.update(creditAccounts).set({ heldMicrousd: account.heldMicrousd + amount }).where(eq(creditAccounts.address, address));
    const [hold] = await tx.insert(creditHolds).values({ address, amountMicrousd: amount }).returning({ id: creditHolds.id });
    return { ok: true, holdId: hold!.id } as const;
  });
}

/** Release a hold and charge what the request really cost, at most the hold (spec §14.2 steps 2–3). Idempotent. */
export async function settleHold(db: Db, input: { holdId: string; cost: bigint; ref: string; meta?: unknown }): Promise<{ charged: bigint }> {
  if (input.cost < 0n) throw new Error("a cost cannot be negative");
  return db.transaction(async (tx) => {
    const [hold] = await tx.select().from(creditHolds).where(eq(creditHolds.id, input.holdId)).for("update");
    if (!hold || hold.releasedAt) return { charged: 0n };
    const account = await lockAccount(tx, hold.address);
    const charged = input.cost > hold.amountMicrousd ? hold.amountMicrousd : input.cost;

    await tx.update(creditHolds).set({ releasedAt: new Date() }).where(eq(creditHolds.id, hold.id));
    if (charged > 0n) {
      await tx.insert(creditLedger).values({ address: hold.address, deltaMicrousd: -charged, kind: "usage", ref: input.ref, meta: input.meta ?? null });
    }
    const held = account.heldMicrousd - hold.amountMicrousd;
    await tx
      .update(creditAccounts)
      .set({ balanceMicrousd: account.balanceMicrousd - charged, heldMicrousd: held < 0n ? 0n : held })
      .where(eq(creditAccounts.address, hold.address));
    return { charged };
  });
}

/**
 * Release holds that a request never settled: the process was killed mid-stream, or timed out. Nothing is
 * charged for them, because what they cost is not known.
 *
 * `olderThan` MUST be well past the longest a chat request can run (the route's `maxDuration`). A hold younger
 * than that may belong to a request still streaming, and releasing it would make that request free.
 * With `address`, only that account's holds: cheap enough to run before every hold is placed.
 */
export async function releaseStaleHolds(db: Db, olderThan: Date, address?: string): Promise<number> {
  const open = and(isNull(creditHolds.releasedAt), lt(creditHolds.createdAt, olderThan), ...(address ? [eq(creditHolds.address, address)] : []));
  const stale = await db.select({ id: creditHolds.id }).from(creditHolds).where(open);
  for (const hold of stale) await settleHold(db, { holdId: hold.id, cost: 0n, ref: `stale:${hold.id}` });
  return stale.length;
}
