import { describe, expect, it } from "vitest";
import {
  MAX_RECENT_RECIPIENTS,
  MAX_RECORDS,
  forAsset,
  forChain,
  parseLog,
  parseRecord,
  recentRecipients,
  record,
  type TransferRecord,
} from "./history";

const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const PEER = "0x1111111111111111111111111111111111111111";
const base: TransferRecord = {
  hash: H(1), kind: "deposit", chainId: 5042002, symbol: "USDC", amount: "0.05", peer: PEER, at: 10,
};

describe("parseRecord", () => {
  it("keeps a well-formed record", () => {
    expect(parseRecord(base)).toEqual(base);
  });

  it("rejects a row that cannot be verified on chain", () => {
    // hash and chainId are the two fatal fields: without both, the row cannot
    // be linked to an explorer, and an unverifiable row is worse than an absent
    // one on a surface whose job is to account for money.
    expect(parseRecord({ ...base, hash: "0xshort" })).toBeNull();
    expect(parseRecord({ ...base, hash: undefined })).toBeNull();
    expect(parseRecord({ ...base, chainId: 0 })).toBeNull();
    expect(parseRecord({ ...base, chainId: "arc" })).toBeNull();
    expect(parseRecord(null)).toBeNull();
  });

  it("repairs display fields rather than dropping a verifiable row", () => {
    const r = parseRecord({ ...base, symbol: "", amount: 5, peer: "nope", at: -1 });
    expect(r).toMatchObject({ symbol: "—", amount: "—", peer: null, at: 0 });
    expect(r?.hash).toBe(base.hash);
  });

  it("defaults an unknown kind to deposit rather than inventing a withdrawal", () => {
    // A mislabelled incoming transfer is a cosmetic error; a mislabelled
    // OUTGOING one tells the user money left when it did not.
    expect(parseRecord({ ...base, kind: "nonsense" })?.kind).toBe("deposit");
    expect(parseRecord({ ...base, kind: "withdraw" })?.kind).toBe("withdraw");
  });
});

describe("parseLog", () => {
  it("treats unreadable storage as empty", () => {
    for (const bad of [null, "", "{oops", '{"a":1}']) expect(parseLog(bad)).toEqual([]);
  });

  it("drops bad rows and keeps the rest, newest first", () => {
    const raw = JSON.stringify([
      { ...base, hash: H(1), at: 1 },
      { ...base, hash: "0xbad" },
      { ...base, hash: H(2), at: 9 },
    ]);
    expect(parseLog(raw).map((r) => r.hash)).toEqual([H(2), H(1)]);
  });

  it("deduplicates by hash", () => {
    const raw = JSON.stringify([base, { ...base, symbol: "ETH" }]);
    expect(parseLog(raw)).toHaveLength(1);
  });
});

describe("record", () => {
  it("puts the newest first", () => {
    const log = record(record([], base), { ...base, hash: H(2), at: 20 });
    expect(log.map((r) => r.hash)).toEqual([H(2), H(1)]);
  });

  it("UPDATES rather than duplicating when the same hash comes back", () => {
    // A retry the wallet answered from cache, or a double render, must not
    // list one transfer twice.
    const log = record(record([], base), { ...base, amount: "0.06" });
    expect(log).toHaveLength(1);
    expect(log[0].amount).toBe("0.06");
  });

  it("ignores an unrecordable transfer instead of storing a broken row", () => {
    expect(record([], { ...base, hash: "0xnope" })).toEqual([]);
  });

  it("caps the log", () => {
    let log: TransferRecord[] = [];
    for (let i = 1; i <= MAX_RECORDS + 5; i++) log = record(log, { ...base, hash: H(i), at: i });
    expect(log).toHaveLength(MAX_RECORDS);
    expect(log[0].hash).toBe(H(MAX_RECORDS + 5));
  });
});

describe("forChain", () => {
  it("filters by chain, and returns everything without one", () => {
    const log = record(record([], base), { ...base, hash: H(2), chainId: 11155931 });
    expect(forChain(log, 5042002).map((r) => r.chainId)).toEqual([5042002]);
    expect(forChain(log)).toHaveLength(2);
  });
});

describe("forAsset", () => {
  const log = [
    { chainId: 5042002, symbol: "USDC", hash: "0x1", kind: "deposit" },
    { chainId: 5042002, symbol: "DONUT", hash: "0x2", kind: "deposit" },
    { chainId: 5042002, symbol: "usdc", hash: "0x3", kind: "withdraw" },
  ] as unknown as TransferRecord[];

  it("narrows to the asset the page is about", () => {
    // The deposit panel asks about one asset; the list under it showed every
    // asset the wallet had ever received.
    expect(forAsset(log, "USDC").map((r) => r.hash)).toEqual(["0x1", "0x3"]);
  });

  it("matches the symbol however it was cased when recorded", () => {
    expect(forAsset(log, "usdc")).toHaveLength(2);
  });

  it("returns everything when no asset is named", () => {
    // Withdraw has no single asset in view, so it must keep the full list.
    expect(forAsset(log, undefined)).toHaveLength(3);
    expect(forAsset(log, "  ")).toHaveLength(3);
  });

  it("answers empty for an asset with no transfers, rather than everything", () => {
    expect(forAsset(log, "HOOPS")).toEqual([]);
  });
});

describe("recentRecipients", () => {
  const row = (over: Partial<TransferRecord>): TransferRecord =>
    ({
      hash: "0x" + "1".repeat(64),
      kind: "withdraw",
      chainId: 5042002,
      symbol: "USDC",
      amount: "1",
      peer: "0x" + "a".repeat(40),
      at: 1,
      ...over,
    }) as TransferRecord;

  it("lists addresses withdrawn to, newest first", () => {
    const log = [
      row({ hash: "0x1", peer: "0xAAA" }),
      row({ hash: "0x2", peer: "0xBBB" }),
    ];
    expect(recentRecipients(log)).toEqual(["0xAAA", "0xBBB"]);
  });

  it("ignores DEPOSITS — a sender is not somewhere you chose to send", () => {
    const log = [row({ hash: "0x1", kind: "deposit", peer: "0xDEAD" })];
    expect(recentRecipients(log)).toEqual([]);
  });

  it("caps at five, so the list stays a shortcut rather than a history", () => {
    const log = Array.from({ length: 12 }, (_, i) =>
      row({ hash: "0x" + i, peer: "0x" + String(i).repeat(4) }),
    );
    expect(recentRecipients(log)).toHaveLength(MAX_RECENT_RECIPIENTS);
  });

  it("deduplicates on casing, keeping the most recent form", () => {
    // The same address differs only by checksum casing; two rows would waste
    // two of the five slots on one destination.
    const log = [
      row({ hash: "0x1", peer: "0xAbCd" }),
      row({ hash: "0x2", peer: "0xABCD" }),
    ];
    expect(recentRecipients(log)).toEqual(["0xAbCd"]);
  });

  it("skips a row with no recorded peer rather than emitting a blank", () => {
    const log = [row({ hash: "0x1", peer: null }), row({ hash: "0x2", peer: "0xBBB" })];
    expect(recentRecipients(log)).toEqual(["0xBBB"]);
  });

  it("is empty for a wallet that has never withdrawn", () => {
    expect(recentRecipients([])).toEqual([]);
  });
});

import { forgetTransfer as forget } from "./history";

describe("forgetTransfer", () => {
  it("removes one record by hash, without regard to case, and leaves the rest", () => {
    const a = { hash: `0x${"aa".repeat(32)}`, kind: "withdraw" as const, chainId: 1, symbol: "USDC", amount: "1", peer: null, at: 2 };
    const b = { ...a, hash: `0x${"bb".repeat(32)}`, at: 1 };
    expect(forget([a, b], a.hash.toUpperCase().replace("0X", "0x")).map((r) => r.hash)).toEqual([b.hash]);
    expect(forget([a, b], `0x${"cc".repeat(32)}`)).toHaveLength(2);
  });
});
