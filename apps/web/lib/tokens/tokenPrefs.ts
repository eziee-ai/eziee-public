"use client";

import { useSyncExternalStore } from "react";
import { readParsed, subscribeStore, writeRaw } from "./localStore";

/** Which tokens a wallet pinned to the top and which it hid, per chain. Ids are lowercased addresses or `"native"`. */
export interface TokenPrefs {
  pinned: string[];
  hidden: string[];
}

const EMPTY: TokenPrefs = { pinned: [], hidden: [] };
const MAX_IDS = 200;

export function tokenPrefsKey(chainId: number, account: string): string {
  return `eziee:token-prefs:${chainId}:${account.toLowerCase()}`;
}

export function tokenId(token: string): string {
  return token.toLowerCase();
}

function ids(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const id = tokenId(item);
    if (id === "native" || /^0x[0-9a-f]{40}$/.test(id)) out.add(id);
  }
  return Array.from(out).slice(0, MAX_IDS);
}

export function parsePrefs(raw: string | null): TokenPrefs {
  if (!raw) return EMPTY;
  try {
    const decoded = JSON.parse(raw) as Partial<Record<keyof TokenPrefs, unknown>> | null;
    if (typeof decoded !== "object" || decoded === null) return EMPTY;
    return { pinned: ids(decoded.pinned), hidden: ids(decoded.hidden) };
  } catch {
    return EMPTY;
  }
}

export function readPrefs(chainId: number, account: string): TokenPrefs {
  return readParsed(tokenPrefsKey(chainId, account), parsePrefs);
}

function write(chainId: number, account: string, prefs: TokenPrefs): boolean {
  return writeRaw(tokenPrefsKey(chainId, account), JSON.stringify(prefs));
}

/** A pinned token is never also hidden. False when the change could only be kept for this page. */
export function togglePin(chainId: number, account: string, token: string): boolean {
  const id = tokenId(token);
  const { pinned, hidden } = readPrefs(chainId, account);
  const on = pinned.includes(id);
  return write(chainId, account, { pinned: on ? pinned.filter((p) => p !== id) : [...pinned, id], hidden: hidden.filter((h) => h !== id) });
}

/** Hiding a token also unpins it. */
export function toggleHide(chainId: number, account: string, token: string): boolean {
  const id = tokenId(token);
  const { pinned, hidden } = readPrefs(chainId, account);
  const on = hidden.includes(id);
  return write(chainId, account, { pinned: pinned.filter((p) => p !== id), hidden: on ? hidden.filter((h) => h !== id) : [...hidden, id] });
}

/** Drops a token from both lists, as when it is removed. Writes nothing when it was in neither. */
export function forgetToken(chainId: number, account: string, token: string): boolean {
  const id = tokenId(token);
  const { pinned, hidden } = readPrefs(chainId, account);
  if (!pinned.includes(id) && !hidden.includes(id)) return true;
  return write(chainId, account, { pinned: pinned.filter((p) => p !== id), hidden: hidden.filter((h) => h !== id) });
}

export function usePrefs(chainId: number, account: string | undefined): TokenPrefs {
  return useSyncExternalStore(
    subscribeStore,
    () => (account ? readPrefs(chainId, account) : EMPTY),
    () => EMPTY,
  );
}
