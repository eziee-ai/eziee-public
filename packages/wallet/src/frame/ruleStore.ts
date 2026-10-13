import type { Rule } from "./rules";

/**
 * Where rules and their daily counters live: IndexedDB on the WALLET FRAME's
 * origin. The app origin cannot read or write it, which is the whole point
 * (spec D4): a rule the frame cannot verify is not a guardrail.
 *
 * Its own database, not `wlt.mera`: that one is opened at a fixed version by the
 * ported key-handling code, and adding a store would mean a version bump inside
 * a file this project does not rewrite.
 *
 * INVARIANT: `reserveSpend` is the only way a counter grows, and it checks the
 * cap and writes the new total inside ONE readwrite transaction. IndexedDB
 * serialises readwrite transactions on a store, so concurrent requests cannot
 * both pass a cap that only one of them fits under.
 * INVARIANT: a reservation is made BEFORE signing and never refunded. A failed
 * broadcast leaves the cap under-used, never over-used.
 */

const DB_NAME = "wlt.rules";
const DB_VERSION = 1;
const RULES = "rules";
const SPENT = "spent";

interface StoredRule extends Omit<Rule, "maxPerTx" | "maxPerDay"> {
  maxPerTx: string;
  maxPerDay: string;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(RULES)) open.result.createObjectStore(RULES, { keyPath: "id" });
      if (!open.result.objectStoreNames.contains(SPENT)) open.result.createObjectStore(SPENT);
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error ?? new Error("The wallet's rule storage could not be opened."));
  }).catch((error: unknown) => {
    dbPromise = null;
    throw error;
  }) as Promise<IDBDatabase>;
  return dbPromise;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("rule storage transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("rule storage transaction aborted"));
  });
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("rule storage request failed"));
  });
}

// bigint is stored as a decimal string: structured clone of BigInt is not universal across the engines this runs in.
const toStored = (rule: Rule): StoredRule => ({ ...rule, maxPerTx: rule.maxPerTx.toString(), maxPerDay: rule.maxPerDay.toString() });
/**
 * Protocol ids that were renamed, as stored in rules made before the rename. Iter shipped as Rate on 2026-10-08:
 * a rule the person made for `iter` keeps covering the same contracts, now decoded as `rate`.
 */
const RENAMED_PROTOCOLS: Readonly<Record<string, string>> = { iter: "rate" };
const fromStored = (row: StoredRule): Rule => ({ ...row, protocol: RENAMED_PROTOCOLS[row.protocol] ?? row.protocol, maxPerTx: BigInt(row.maxPerTx), maxPerDay: BigInt(row.maxPerDay) });
const spentKey = (ruleId: string, day: string) => `${ruleId}:${day}`;

export async function listRules(): Promise<Rule[]> {
  const db = await openDb();
  const rows = await request(db.transaction(RULES, "readonly").objectStore(RULES).getAll() as IDBRequest<StoredRule[]>);
  return rows.map(fromStored).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/** `add`, not `put`: a rule id is never silently replaced with different terms. */
export async function addRule(rule: Rule): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(RULES, "readwrite");
  tx.objectStore(RULES).add(toStored(rule));
  await done(tx);
}

export async function revokeRule(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([RULES, SPENT], "readwrite");
  tx.objectStore(RULES).delete(id);
  // Counter keys are `${id}:${day}`; ":" sorts before ";" so this range is exactly this rule's days.
  tx.objectStore(SPENT).delete(IDBKeyRange.bound(`${id}:`, `${id};`, false, true));
  await done(tx);
}

async function deleteWhere(predicate: (rule: Rule) => boolean): Promise<void> {
  for (const rule of await listRules()) if (predicate(rule)) await revokeRule(rule.id);
}

/** Called when the session ends (spec §5.3): session-scoped rules die with it. */
export function clearSessionRules(): Promise<void> {
  return deleteWhere((rule) => !rule.persistent);
}

export function purgeExpired(now: number): Promise<void> {
  return deleteWhere((rule) => rule.expiresAt <= now);
}

export async function spentOn(ruleId: string, day: string): Promise<bigint> {
  const db = await openDb();
  const value = await request(db.transaction(SPENT, "readonly").objectStore(SPENT).get(spentKey(ruleId, day)) as IDBRequest<string | undefined>);
  return BigInt(value ?? "0");
}

/**
 * Atomically add `amount` to a rule's counter for `day` if the total stays
 * within `cap`. Returns whether the reservation was made.
 */
export async function reserveSpend(ruleId: string, day: string, amount: bigint, cap: bigint): Promise<boolean> {
  if (amount <= 0n) return false;
  const db = await openDb();
  const tx = db.transaction(SPENT, "readwrite");
  const store = tx.objectStore(SPENT);
  const key = spentKey(ruleId, day);
  let reserved = false;
  const read = store.get(key) as IDBRequest<string | undefined>;
  read.onsuccess = () => {
    const next = BigInt(read.result ?? "0") + amount;
    if (next > cap) return;
    store.put(next.toString(), key);
    reserved = true;
  };
  await done(tx);
  return reserved;
}

/** Test seam: a fresh database per test. Not exported from the package. */
export async function resetRuleStoreForTests(): Promise<void> {
  if (dbPromise) (await dbPromise).close();
  dbPromise = null;
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}
