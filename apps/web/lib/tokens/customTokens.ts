"use client";

import { useSyncExternalStore } from "react";
import { getAddress, isAddress, type Address } from "viem";
import { clean } from "@repo/protocols/text";
import { readParsed, subscribeStore, writeRaw } from "./localStore";
import { forgetToken } from "./tokenPrefs";

/**
 * Tokens a person added by address, per chain and wallet, in this browser.
 *
 * Each was read from the chain before it was stored (see `verifyToken`). They are for display and
 * withdrawal only: nothing here reaches the model's tools or the protocol registry, so the
 * assistant never trades a token that was not reviewed.
 */
export interface CustomToken {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
}

export const MAX_CUSTOM_TOKENS = 50;
export const SYMBOL_MAX = 20;
export const NAME_MAX = 64;
export const MAX_DECIMALS = 36;
const EMPTY: CustomToken[] = [];

export function customTokensKey(chainId: number, account: string): string {
  return `eziee:tokens:${chainId}:${account.toLowerCase()}`;
}

/** One stored value as a token, or null. Applied on the way in and on the way out. */
export function parseCustomToken(value: unknown): CustomToken | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Partial<Record<keyof CustomToken, unknown>>;
  if (typeof row.address !== "string" || !isAddress(row.address, { strict: false })) return null;
  if (typeof row.decimals !== "number" || !Number.isInteger(row.decimals) || row.decimals < 0 || row.decimals > MAX_DECIMALS) return null;
  const symbol = clean(row.symbol, SYMBOL_MAX);
  if (symbol === "" || symbol !== row.symbol) return null;
  const name = clean(row.name, NAME_MAX);
  return { address: getAddress(row.address.toLowerCase()), symbol, name: name || symbol, decimals: row.decimals };
}

export function parseCustomTokens(raw: string | null): CustomToken[] {
  if (!raw) return EMPTY;
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return EMPTY;
  }
  if (!Array.isArray(decoded)) return EMPTY;
  const seen = new Set<string>();
  const out: CustomToken[] = [];
  for (const value of decoded) {
    const token = parseCustomToken(value);
    if (!token || seen.has(token.address.toLowerCase())) continue;
    seen.add(token.address.toLowerCase());
    out.push(token);
  }
  return out.slice(0, MAX_CUSTOM_TOKENS);
}

export function listCustomTokens(chainId: number, account: string): CustomToken[] {
  return readParsed(customTokensKey(chainId, account), parseCustomTokens);
}

/** False when the token was refused or could only be kept for this page. */
export function addCustomToken(chainId: number, account: string, token: CustomToken): boolean {
  const parsed = parseCustomToken(token);
  if (!parsed) return false;
  const rest = listCustomTokens(chainId, account).filter((t) => t.address.toLowerCase() !== parsed.address.toLowerCase());
  return writeRaw(customTokensKey(chainId, account), JSON.stringify([...rest, parsed].slice(-MAX_CUSTOM_TOKENS)));
}

/** Its pin and hide go with it, so a token added again later starts plain. */
export function removeCustomToken(chainId: number, account: string, address: string): boolean {
  const rest = listCustomTokens(chainId, account).filter((t) => t.address.toLowerCase() !== address.toLowerCase());
  const stored = writeRaw(customTokensKey(chainId, account), JSON.stringify(rest));
  return forgetToken(chainId, account, address) && stored;
}

export function useCustomTokens(chainId: number, account: string | undefined): CustomToken[] {
  return useSyncExternalStore(
    subscribeStore,
    () => (account ? listCustomTokens(chainId, account) : EMPTY),
    () => EMPTY,
  );
}
