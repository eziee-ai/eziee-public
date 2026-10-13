import { useSyncExternalStore } from "react";

/**
 * Deposits that were sent and are not yet credited, kept in this browser.
 *
 * Money has already moved when one of these exists, so it must survive a reload, a closed tab and a crash: the
 * page resumes checking each one until the server says it is credited or refuses it. Losing one loses no money
 * (the person can paste nothing; the server credits by hash whenever it is asked), but they would not know that.
 */
export interface PendingTopUp {
  chainId: number;
  hash: `0x${string}`;
  /** For display only: what the person chose to send. The credited amount is whatever the chain says. */
  amount: string;
  account: `0x${string}`;
  /** ms since the epoch, when it was sent. Older records have none and are treated as old. */
  sentAt?: number;
  /** One of the operator's tokens; absent for USDC. */
  token?: `0x${string}`;
  symbol?: string;
}

const KEY = "wlt.pending-topups";
export const MAX_PENDING = 20;
const listeners = new Set<() => void>();
let cached: { raw: string | null; value: PendingTopUp[] } = { raw: null, value: [] };

const isPending = (value: unknown): value is PendingTopUp =>
  typeof value === "object" && value !== null && typeof (value as PendingTopUp).chainId === "number" && /^0x[0-9a-fA-F]{64}$/.test((value as PendingTopUp).hash ?? "") && typeof (value as PendingTopUp).amount === "string" && /^[0-9.]{1,40}$/.test((value as PendingTopUp).amount) && /^0x[0-9a-fA-F]{40}$/.test((value as PendingTopUp).account ?? "") && ((value as PendingTopUp).sentAt === undefined || typeof (value as PendingTopUp).sentAt === "number") && ((value as PendingTopUp).token === undefined || /^0x[0-9a-fA-F]{40}$/.test(String((value as PendingTopUp).token))) && ((value as PendingTopUp).symbol === undefined || /^[^<>]{1,20}$/.test(String((value as PendingTopUp).symbol)));

function read(): PendingTopUp[] {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(KEY);
  } catch {
    return cached.value;
  }
  if (raw === cached.raw) return cached.value;
  let value: PendingTopUp[] = [];
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    // The NEWEST are kept: the record most worth having is the deposit that was just sent.
    value = Array.isArray(parsed) ? parsed.filter(isPending).slice(-MAX_PENDING) : [];
  } catch {
    value = [];
  }
  cached = { raw, value };
  return value;
}

function write(all: PendingTopUp[]): void {
  const next = all.slice(-MAX_PENDING);
  const raw = JSON.stringify(next);
  try {
    window.localStorage.setItem(KEY, raw);
    cached = { raw, value: next };
  } catch {
    // Storage is unavailable (private mode). Keep it for the life of this page at least.
    cached = { raw: cached.raw, value: next };
  }
  for (const listener of listeners) listener();
}

export function addPendingTopUp(entry: PendingTopUp): void {
  write([...read().filter((existing) => existing.hash.toLowerCase() !== entry.hash.toLowerCase()), entry]);
}

export function removePendingTopUp(hash: string): void {
  write(read().filter((existing) => existing.hash.toLowerCase() !== hash.toLowerCase()));
}

export const readPendingTopUps = read;

const EMPTY: PendingTopUp[] = [];
export function usePendingTopUps(): PendingTopUp[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      // Another tab of this app added or settled a deposit.
      const onStorage = (event: StorageEvent) => {
        if (event.key === KEY) listener();
      };
      window.addEventListener("storage", onStorage);
      return () => {
        listeners.delete(listener);
        window.removeEventListener("storage", onStorage);
      };
    },
    read,
    () => EMPTY,
  );
}
