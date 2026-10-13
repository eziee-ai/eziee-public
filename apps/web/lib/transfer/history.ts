/**
 * A record of transfers THIS APP submitted, in this browser.
 *
 * ## Read this before treating it as account history
 *
 * It is not one, and the UI must not present it as one. Nothing in this
 * monorepo indexes value transfers: the broker indexes the exchange's own
 * events — orders, fills, launches, band liquidity — and there is no handler
 * for an ERC-20 `Transfer`, which is also why the token profile's holders
 * column is a share of TRADED supply rather than of supply.
 *
 * So a deposit someone makes by scanning the QR from a phone is invisible here,
 * on every device including the one that generated the QR. What this file
 * records is the subset the app itself put on chain and therefore knows the
 * hash of: a browser-wallet deposit, and a withdrawal.
 *
 * That is a real limit, not a temporary one, and the panel says so rather than
 * showing an empty list that reads as "you have never deposited". Making it
 * complete needs an indexer handler for `Transfer` filtered to the account, at
 * which point this becomes a local cache in front of it and the shape below
 * does not change.
 *
 * Local for the same reason `addressBook` is: there is no account table in this
 * monorepo, and inventing one to hold a transfer log is a privacy decision this
 * change is not entitled to make.
 */

import { normalizeAmountInput } from "./numberInput";

export const TRANSFER_LOG_KEY = "wlt.transfers";
export const MAX_RECORDS = 100;

export type TransferKind = "deposit" | "withdraw";

export interface TransferRecord {
  /** Transaction hash. The identity — recording the same one twice is a no-op. */
  hash: string;
  kind: TransferKind;
  chainId: number;
  /** Ticker as shown, e.g. "USDC". Display only. */
  symbol: string;
  /** Decimal string, as typed. Never a float — see the USD notation rules. */
  amount: string;
  /** Counterparty: where a withdrawal went, or where a deposit came from. */
  peer: string | null;
  /** Epoch ms at submission. */
  at: number;
}

/** An amount for display: as typed, minus the ways a field let it be malformed. */
function normalizedAmount(value: unknown): string {
  if (typeof value !== "string") return "—";
  const cleaned = normalizeAmountInput(value.trim()).slice(0, 40);
  return cleaned === "" ? "—" : cleaned;
}

const isHash = (v: unknown): v is string =>
  typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);

/**
 * Coerce one unknown value into a record, or null.
 *
 * `hash` and `chainId` are fatal: without both, a row cannot be linked to an
 * explorer, and a row that cannot be verified is worse than an absent one on a
 * surface whose whole job is to account for money. Everything else is repaired.
 */
export function parseRecord(value: unknown): TransferRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Partial<TransferRecord>;
  if (!isHash(row.hash)) return null;
  if (typeof row.chainId !== "number" || !Number.isFinite(row.chainId) || row.chainId <= 0) {
    return null;
  }
  return {
    hash: row.hash,
    kind: row.kind === "withdraw" ? "withdraw" : "deposit",
    chainId: row.chainId,
    symbol: typeof row.symbol === "string" && row.symbol.trim() ? row.symbol.trim().slice(0, 16) : "—",
    // NORMALISED, not just trimmed. The amount is stored as typed, and the
    // field used to let a leading zero through — so a deposit of 18 was
    // recorded, and listed, as "018 USDC". Doing it here rather than only at
    // the input also repairs rows already in storage, since every read goes
    // through this function.
    amount: normalizedAmount(row.amount),
    peer:
      typeof row.peer === "string" && /^0x[0-9a-fA-F]{40}$/.test(row.peer) ? row.peer : null,
    at: typeof row.at === "number" && Number.isFinite(row.at) && row.at > 0 ? row.at : 0,
  };
}

export function parseLog(raw: string | null): TransferRecord[] {
  if (!raw) return [];
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(decoded)) return [];
  const seen = new Set<string>();
  const out: TransferRecord[] = [];
  for (const value of decoded) {
    const record = parseRecord(value);
    if (!record) continue;
    const key = record.hash.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(record);
  }
  return out.sort((a, b) => b.at - a.at).slice(0, MAX_RECORDS);
}

/**
 * Add a record, newest first.
 *
 * Keyed on the hash, so re-submitting the same transaction — a retry that the
 * wallet answered from cache, or a double render — updates the existing row
 * instead of listing one transfer twice.
 */
export function record(
  log: readonly TransferRecord[],
  next: TransferRecord,
): TransferRecord[] {
  const parsed = parseRecord(next);
  if (!parsed) return [...log];
  const rest = log.filter((r) => r.hash.toLowerCase() !== parsed.hash.toLowerCase());
  return [parsed, ...rest].slice(0, MAX_RECORDS);
}

/** Records for one chain, or all of them when `chainId` is undefined. */
export function forChain(
  log: readonly TransferRecord[],
  chainId?: number,
): TransferRecord[] {
  return chainId === undefined ? [...log] : log.filter((r) => r.chainId === chainId);
}

/**
 * Records for one ASSET, or all of them when `symbol` is undefined.
 *
 * The deposit and withdraw pages each ask about one asset at a time — the
 * deposit panel's whole job is "add USDC to this wallet", and withdraw derives
 * the chain FROM the chosen asset — and the list under them showed every asset
 * the wallet had ever touched, so the row the user was looking for was the
 * hardest one to find.
 *
 * Matched case-insensitively on the symbol, which is what the record stores.
 * That is deliberately loose: this is a VIEW filter over rows the user already
 * owns, so the cost of a false match is one extra row, not a mistaken payment.
 * Nothing that decides value may match on a symbol — see the token-catalogue
 * rule about anyone being able to mint a coin called USDC.
 */
export function forAsset(
  log: readonly TransferRecord[],
  symbol?: string,
): TransferRecord[] {
  // Trimmed BEFORE the emptiness check: a whitespace-only symbol is truthy, so
  // testing `symbol` alone filtered the list down to nothing rather than
  // leaving it alone. An absent asset must always widen, never narrow.
  const wanted = symbol?.trim().toUpperCase();
  if (!wanted) return [...log];
  return log.filter((r) => r.symbol.toUpperCase() === wanted);
}

/** How many recent recipients the picker offers. */
export const MAX_RECENT_RECIPIENTS = 5;

/**
 * Addresses this wallet has withdrawn to, newest first.
 *
 * DERIVED from the transfer log rather than kept in a store of its own, and
 * that is the whole design. Every confirmed withdrawal already records its
 * `peer`, so a second list could only ever be a copy that drifts — and each new
 * storage key also owes a row in `/cookies`. Nothing new is written; this reads
 * what is already there.
 *
 * Because the log is written at the RECEIPT (see `useTransferConfirmation`), an
 * address appears here only after a withdrawal to it actually confirmed. A
 * transfer that reverted is not somewhere you have successfully sent, and
 * offering it as one would be a recommendation the evidence does not support.
 *
 * Deduplicated case-insensitively, keeping the most recent occurrence: EVM
 * addresses differ only by checksum casing, and listing one address twice in a
 * five-row list wastes two of the five.
 *
 * NOT filtered by chain. An EOA exists at the same address on every EVM chain,
 * and the saved address book is not chain-scoped either; scoping this one would
 * make the two disagree about the same address for no gain.
 */
export function recentRecipients(
  log: readonly TransferRecord[],
  limit: number = MAX_RECENT_RECIPIENTS,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  // The log is already newest-first; sorting again would only re-derive that.
  for (const row of log) {
    if (row.kind !== "withdraw") continue;
    const peer = row.peer;
    if (!peer) continue;
    const key = peer.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(peer);
    if (out.length >= limit) break;
  }
  return out;
}

export function readLog(): TransferRecord[] {
  try {
    return parseLog(globalThis.localStorage?.getItem(TRANSFER_LOG_KEY) ?? null);
  } catch {
    return [];
  }
}

export function writeLog(log: readonly TransferRecord[]): boolean {
  try {
    globalThis.localStorage?.setItem(TRANSFER_LOG_KEY, JSON.stringify(log));
    return true;
  } catch {
    return false;
  }
}

/** Convenience: read, add, write. Returns the new log regardless of whether it persisted. */
export function appendTransfer(next: TransferRecord): TransferRecord[] {
  const updated = record(readLog(), next);
  writeLog(updated);
  // Even when the write failed: the row is correct for this session, and a list
  // that ignores it is wrong on screen as well as in storage.
  notifyTransfers(updated);
  return updated;
}

/*
 * A module store, so a list re-reads when a transfer is recorded.
 *
 * `readLog()` in a mount effect was a snapshot: nothing told the panel a row
 * had arrived, so a deposit confirmed while the page was open and the table
 * below it went on showing what storage held when it mounted. The same
 * `useSyncExternalStore` shape `useChainBrand` uses, and for the same reason —
 * no provider requirement on something a decorative surface subscribes to.
 */
type Listener = () => void;
const listeners = new Set<Listener>();
/** Cached so `getSnapshot` returns a STABLE reference; React loops otherwise. */
let snapshot: TransferRecord[] | null = null;
const EMPTY: TransferRecord[] = [];

export function subscribeTransfers(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function transfersSnapshot(): TransferRecord[] {
  if (snapshot === null) snapshot = readLog();
  return snapshot;
}

/** The server has no storage; an empty list keeps hydration matching. */
export function transfersServerSnapshot(): TransferRecord[] {
  return EMPTY;
}

function notifyTransfers(next: TransferRecord[]): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

/**
 * Added for this app (not in the Rate original): drop one record by hash.
 * A withdrawal that REVERTED moved nothing, so it must not sit in the list as a
 * sent amount, nor offer its recipient as one the user has sent to before.
 */
export function forgetTransfer(log: readonly TransferRecord[], hash: string): TransferRecord[] {
  return log.filter((row) => row.hash.toLowerCase() !== hash.toLowerCase());
}

/** Read, forget, write, and tell subscribers. */
export function removeTransfer(hash: string): void {
  const updated = forgetTransfer(readLog(), hash);
  writeLog(updated);
  notifyTransfers(updated);
}
