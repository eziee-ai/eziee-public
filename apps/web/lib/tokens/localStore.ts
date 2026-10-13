/**
 * The small browser store behind the tokens page: raw strings in `localStorage`, read through
 * `useSyncExternalStore`.
 *
 * Storage can be missing (a private window, blocked site data) or throw on every access. Then a
 * write still applies to this page through an in-memory copy, and the caller is told it will not
 * survive a reload. Snapshots are cached per key and raw string, so an unchanged store returns the
 * same object and React does not re-render in a loop.
 */

const listeners = new Set<() => void>();
const memory = new Map<string, string>();
const parsed = new Map<string, { raw: string | null; value: unknown }>();

function storage(): Storage | undefined {
  return (globalThis as { localStorage?: Storage }).localStorage ?? undefined;
}

export function readRaw(key: string): string | null {
  // This page's copy first: it only exists when the last write could not be stored (blocked
  // storage, or a full quota), and then it is newer than whatever storage still holds.
  const own = memory.get(key);
  if (own !== undefined) return own;
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Returns false when the value could only be kept for this page. */
export function writeRaw(key: string, value: string): boolean {
  let stored = false;
  try {
    const target = storage();
    if (target) {
      target.setItem(key, value);
      stored = true;
    }
  } catch {
    stored = false;
  }
  if (stored) memory.delete(key);
  else memory.set(key, value);
  for (const listener of listeners) listener();
  return stored;
}

/** `parse(raw)`, computed once per distinct raw string. */
export function readParsed<T>(key: string, parse: (raw: string | null) => T): T {
  const raw = readRaw(key);
  const hit = parsed.get(key);
  if (hit && hit.raw === raw) return hit.value as T;
  const value = parse(raw);
  parsed.set(key, { raw, value });
  return value;
}

function onStorage() {
  for (const listener of listeners) listener();
}

export function subscribeStore(listener: () => void): () => void {
  listeners.add(listener);
  // Another tab changed the store.
  if (listeners.size === 1 && typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

/** Tests only: forget this page's copies. */
export function resetStoreMemory(): void {
  memory.clear();
  parsed.clear();
}
