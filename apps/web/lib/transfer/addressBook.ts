/**
 * Saved withdrawal destinations, in this browser.
 *
 * ## Why local, and why that is not a placeholder
 *
 * There is no account table in this monorepo. `privyUsers` / `privyWallets` were
 * dropped with Privy and held zero rows; the app stores a wallet address and
 * nothing else, which is what `/privacy` says. A server-side address book would
 * therefore be the first table that binds a person's saved payees to their
 * wallet — a real privacy decision, not an implementation detail, and one this
 * change is not entitled to make on its own.
 *
 * So the book lives in `localStorage`, and the UI says so rather than implying a
 * sync that does not happen. If it later moves to a service, only `read`/`write`
 * change; nothing else in the app touches the storage key.
 *
 * ## Validation is not optional here
 *
 * These values reach a `to:` field in a transaction. A hand-edited or corrupted
 * entry must be dropped on the way OUT of storage as well as on the way in —
 * the same rule `lib/referral/pending` follows for a code that reaches a URL,
 * and the stakes here are higher: the worst case is funds sent somewhere the
 * user never typed.
 */

export const ADDRESS_BOOK_KEY = "wlt.address-book";

/** How many entries the book holds. Beyond this the oldest is dropped. */
export const MAX_ENTRIES = 50;
export const MAX_LABEL_LENGTH = 40;

export interface SavedAddress {
  /** Checksummed or lowercase 0x address. Compared case-insensitively. */
  address: string;
  /** What the user called it. Never empty — `save` falls back to the address. */
  label: string;
  /** Epoch ms. Ordering only; never rendered as a precise time. */
  savedAt: number;
}

const isAddress = (value: unknown): value is string =>
  typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);

/**
 * Coerce one unknown value into an entry, or null.
 *
 * A bad `label` or `savedAt` is REPAIRED rather than fatal — neither can send
 * money anywhere, and dropping a valid address because its label got mangled
 * would lose the only thing that matters. A bad `address` is always fatal.
 */
export function parseEntry(value: unknown): SavedAddress | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Partial<SavedAddress>;
  if (!isAddress(row.address)) return null;
  const label =
    typeof row.label === "string" && row.label.trim().length > 0
      ? row.label.trim().slice(0, MAX_LABEL_LENGTH)
      : shortenAddress(row.address);
  const savedAt =
    typeof row.savedAt === "number" && Number.isFinite(row.savedAt) && row.savedAt > 0
      ? row.savedAt
      : 0;
  return { address: row.address, label, savedAt };
}

/** Parse a whole stored book. Unreadable storage and bad JSON both mean "empty". */
export function parseBook(raw: string | null): SavedAddress[] {
  if (!raw) return [];
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(decoded)) return [];
  const seen = new Set<string>();
  const out: SavedAddress[] = [];
  for (const value of decoded) {
    const entry = parseEntry(value);
    if (!entry) continue;
    const key = entry.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out.sort((a, b) => b.savedAt - a.savedAt).slice(0, MAX_ENTRIES);
}

/**
 * Add or rename an entry, newest first.
 *
 * Saving an address already in the book RENAMES it rather than adding a second
 * row — one address is one payee, and two rows for it is how a user picks the
 * stale label and believes the wrong thing about where they are sending.
 */
export function upsert(
  book: readonly SavedAddress[],
  address: string,
  label: string,
  now: number,
): SavedAddress[] {
  if (!isAddress(address)) return [...book];
  const clean = label.trim().slice(0, MAX_LABEL_LENGTH) || shortenAddress(address);
  const rest = book.filter((e) => e.address.toLowerCase() !== address.toLowerCase());
  return [{ address, label: clean, savedAt: now }, ...rest].slice(0, MAX_ENTRIES);
}

export function remove(book: readonly SavedAddress[], address: string): SavedAddress[] {
  return book.filter((e) => e.address.toLowerCase() !== address.toLowerCase());
}

/** The saved label for an address, or null. Case-insensitive. */
export function labelFor(book: readonly SavedAddress[], address: string): string | null {
  return book.find((e) => e.address.toLowerCase() === address.toLowerCase())?.label ?? null;
}

export function shortenAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** Read the book. Never throws — private mode and blocked storage both answer empty. */
export function readBook(): SavedAddress[] {
  try {
    return parseBook(globalThis.localStorage?.getItem(ADDRESS_BOOK_KEY) ?? null);
  } catch {
    return [];
  }
}

/**
 * Persist the book. Returns false when the write did not happen, so a caller can
 * say the entry will not survive the page rather than silently promising
 * storage it does not have — the same failure the support widget reports.
 */
export function writeBook(book: readonly SavedAddress[]): boolean {
  try {
    globalThis.localStorage?.setItem(ADDRESS_BOOK_KEY, JSON.stringify(book));
    return true;
  } catch {
    return false;
  }
}
