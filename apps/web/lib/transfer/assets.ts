import type { Address } from "viem";
import type { Token } from "@repo/protocols/types";
import type { CustomToken } from "@/lib/tokens/customTokens";
import type { TransferAsset } from "./withdrawForm";

interface BalanceRow {
  token: Address | "native";
  symbol: string;
  decimals: number;
  amount: string;
}

/**
 * What the wallet holds, as rows the transfer pages list: the registry's tokens with their own
 * trust, the native asset as canonical, and custom tokens as unreviewed. A custom token at a
 * registry address is dropped: the reviewed entry wins, whatever symbol the custom one carries.
 */
export function toTransferAssets(input: {
  chainId: number;
  rows: readonly BalanceRow[];
  registry: readonly Token[];
  nativeName: string;
  extras: readonly CustomToken[];
  /**
   * Balances of `extras`, keyed by lowercased address. `null` means the read failed: that token is left out
   * here (see `unreadableExtras`), never listed as zero. A token with no entry is left out until it is read.
   */
  extraHeld: ReadonlyMap<string, bigint | null> | undefined;
}): TransferAsset[] {
  const { chainId, rows, registry, nativeName, extras, extraHeld } = input;
  const listed = new Map(registry.map((t) => [t.address.toLowerCase(), t]));
  const known: TransferAsset[] = rows.map((row) => {
    const token = row.token === "native" ? undefined : listed.get(row.token.toLowerCase());
    return {
      chainId,
      token: row.token,
      symbol: row.symbol,
      name: row.token === "native" ? nativeName : (token?.name ?? row.symbol),
      decimals: row.decimals,
      held: BigInt(row.amount),
      trust: row.token === "native" ? "canonical" : (token?.trust ?? "listed"),
    };
  });
  const custom: TransferAsset[] = [];
  for (const extra of unlistedExtras(extras, registry)) {
    const held = extraHeld?.get(extra.address.toLowerCase());
    if (held === undefined || held === null) continue;
    custom.push({ chainId, token: extra.address, symbol: extra.symbol, name: extra.name, decimals: extra.decimals, held, trust: "unreviewed" });
  }
  return [...known, ...custom];
}

/** Custom tokens that are not on the registry. */
export function unlistedExtras(extras: readonly CustomToken[], registry: readonly Token[]): CustomToken[] {
  const listed = new Set(registry.map((t) => t.address.toLowerCase()));
  return extras.filter((t) => !listed.has(t.address.toLowerCase()));
}

/** Custom tokens whose balance read failed. They are shown as "balance unavailable", so they can still be removed. */
export function unreadableExtras(extras: readonly CustomToken[], registry: readonly Token[], extraHeld: ReadonlyMap<string, bigint | null> | undefined): CustomToken[] {
  if (!extraHeld) return [];
  return unlistedExtras(extras, registry).filter((t) => extraHeld.get(t.address.toLowerCase()) === null);
}

/** An unreviewed token that gives itself the symbol of a reviewed token on the same chain. */
export function sharesListedSymbol(asset: Pick<TransferAsset, "chainId" | "symbol" | "trust">, registry: readonly Token[]): boolean {
  if (asset.trust !== "unreviewed") return false;
  const symbol = asset.symbol.toUpperCase();
  return registry.some((t) => t.chainId === asset.chainId && t.symbol.toUpperCase() === symbol);
}
