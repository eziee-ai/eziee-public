// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  vi.resetModules();
  vi.stubGlobal("window", { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }, addEventListener: () => {}, removeEventListener: () => {} });
});

const ACCOUNT = "0x0000000000000000000000000000000000001001" as const;
const entry = (n: number) => ({ chainId: 5042002, hash: `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`, amount: "5", account: ACCOUNT, sentAt: 1_000 + n });

describe("pending top-ups", () => {
  it("remembers a deposit across a reload, and forgets it when told", async () => {
    const first = await import("./pendingTopUps");
    first.addPendingTopUp(entry(1));
    vi.resetModules();
    const second = await import("./pendingTopUps");
    expect(second.readPendingTopUps()).toEqual([entry(1)]);
    second.removePendingTopUp(entry(1).hash);
    expect(second.readPendingTopUps()).toEqual([]);
  });

  it("when there are too many, drops the OLDEST, never the deposit that was just sent", async () => {
    const { addPendingTopUp, readPendingTopUps, MAX_PENDING } = await import("./pendingTopUps");
    for (let n = 1; n <= MAX_PENDING + 3; n++) addPendingTopUp(entry(n));
    const kept = readPendingTopUps();
    expect(kept).toHaveLength(MAX_PENDING);
    expect(kept.at(-1)).toEqual(entry(MAX_PENDING + 3));
    expect(kept[0]).toEqual(entry(4));
  });

  it("gives the same array back while nothing changed, so a subscriber does not re-render forever", async () => {
    const { addPendingTopUp, readPendingTopUps } = await import("./pendingTopUps");
    addPendingTopUp(entry(1));
    expect(readPendingTopUps()).toBe(readPendingTopUps());
  });

  it("ignores what is not a deposit record, however it got into storage", async () => {
    store.set("wlt.pending-topups", JSON.stringify([{ chainId: "x" }, entry(2), { ...entry(3), hash: "<script>" }, null]));
    const { readPendingTopUps } = await import("./pendingTopUps");
    expect(readPendingTopUps()).toEqual([entry(2)]);
  });
});
