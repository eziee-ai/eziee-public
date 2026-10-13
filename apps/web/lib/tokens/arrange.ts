import type { TokenPrefs } from "./tokenPrefs";

interface Row {
  token: string;
  symbol: string;
  decimals: number;
  held: bigint;
}

const SCALE = 36;

/** The balance on one scale, so tokens with different decimals compare by amount, not by base units. */
function scaled(row: Row): bigint {
  return row.held * 10n ** BigInt(Math.max(0, SCALE - row.decimals));
}

/** Pinned first, then the larger balance, then by symbol. Hidden tokens are split off. */
export function arrangeTokens<T extends Row>(rows: readonly T[], prefs: TokenPrefs): { shown: T[]; hidden: T[] } {
  const pinned = new Set(prefs.pinned.map((p) => p.toLowerCase()));
  const hiddenIds = new Set(prefs.hidden.map((h) => h.toLowerCase()));
  const order = (a: T, b: T) => {
    const pin = Number(pinned.has(b.token.toLowerCase())) - Number(pinned.has(a.token.toLowerCase()));
    if (pin !== 0) return pin;
    const x = scaled(a);
    const y = scaled(b);
    if (x !== y) return x > y ? -1 : 1;
    return a.symbol.localeCompare(b.symbol);
  };
  const sorted = [...rows].sort(order);
  return { shown: sorted.filter((r) => !hiddenIds.has(r.token.toLowerCase())), hidden: sorted.filter((r) => hiddenIds.has(r.token.toLowerCase())) };
}
