import { describe, expect, it } from "vitest";
import {
  MAX_ENTRIES,
  labelFor,
  parseBook,
  parseEntry,
  remove,
  upsert,
} from "./addressBook";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";

describe("parseEntry", () => {
  it("keeps a well-formed entry", () => {
    expect(parseEntry({ address: A, label: "Cold wallet", savedAt: 5 })).toEqual({
      address: A,
      label: "Cold wallet",
      savedAt: 5,
    });
  });

  it("rejects anything whose ADDRESS is not an address", () => {
    // The one field that is fatal: this value reaches a transaction's `to`.
    for (const bad of [
      { address: "0xnope", label: "x", savedAt: 1 },
      { address: A.slice(0, 41), label: "x", savedAt: 1 },
      { address: 42, label: "x", savedAt: 1 },
      { label: "x", savedAt: 1 },
      null,
      "0x1111",
    ]) {
      expect(parseEntry(bad)).toBeNull();
    }
  });

  it("REPAIRS a bad label instead of dropping the address", () => {
    // Losing a saved payee because its label got mangled would throw away the
    // only part that matters. Neither a label nor a timestamp can send money.
    expect(parseEntry({ address: A, label: "   ", savedAt: 1 })?.label).toBe("0x1111…1111");
    expect(parseEntry({ address: A, label: 7, savedAt: 1 })?.label).toBe("0x1111…1111");
    expect(parseEntry({ address: A, label: "x", savedAt: "soon" })?.savedAt).toBe(0);
  });

  it("truncates a label rather than storing an unbounded string", () => {
    const entry = parseEntry({ address: A, label: "n".repeat(500), savedAt: 1 });
    expect(entry?.label.length).toBe(40);
  });
});

describe("parseBook", () => {
  it("treats empty, malformed and non-array storage as an empty book", () => {
    // Unreadable storage must never be fatal on a page that also has to let
    // someone withdraw without it.
    expect(parseBook(null)).toEqual([]);
    expect(parseBook("")).toEqual([]);
    expect(parseBook("{not json")).toEqual([]);
    expect(parseBook('{"address":"0x1"}')).toEqual([]);
  });

  it("drops invalid rows but keeps the valid ones around them", () => {
    const raw = JSON.stringify([
      { address: A, label: "Good", savedAt: 2 },
      { address: "0xbad", label: "Bad", savedAt: 3 },
      { address: B, label: "Also good", savedAt: 1 },
    ]);
    expect(parseBook(raw).map((e) => e.address)).toEqual([A, B]);
  });

  it("deduplicates by address, case-insensitively", () => {
    const raw = JSON.stringify([
      { address: A, label: "First", savedAt: 2 },
      { address: A.toUpperCase().replace("0X", "0x"), label: "Second", savedAt: 1 },
    ]);
    const book = parseBook(raw);
    expect(book).toHaveLength(1);
    expect(book[0].label).toBe("First");
  });

  it("orders newest first and caps the book", () => {
    const raw = JSON.stringify(
      Array.from({ length: MAX_ENTRIES + 10 }, (_, i) => ({
        address: `0x${String(i).padStart(40, "0")}`,
        label: `n${i}`,
        savedAt: i,
      })),
    );
    const book = parseBook(raw);
    expect(book).toHaveLength(MAX_ENTRIES);
    expect(book[0].savedAt).toBeGreaterThan(book[1].savedAt);
  });
});

describe("upsert", () => {
  it("adds newest first", () => {
    const book = upsert(upsert([], A, "One", 1), B, "Two", 2);
    expect(book.map((e) => e.address)).toEqual([B, A]);
  });

  it("RENAMES an existing address rather than adding a second row", () => {
    // Two rows for one payee is how a user picks the stale label and believes
    // the wrong thing about where they are sending.
    const book = upsert(upsert([], A, "Old name", 1), A, "New name", 2);
    expect(book).toHaveLength(1);
    expect(book[0].label).toBe("New name");
  });

  it("matches case-insensitively when renaming", () => {
    const book = upsert(upsert([], A, "Old", 1), A.replace("0x1", "0X1"), "New", 2);
    expect(book).toHaveLength(1);
  });

  it("falls back to the shortened address for an empty label", () => {
    expect(upsert([], A, "   ", 1)[0].label).toBe("0x1111…1111");
  });

  it("refuses a malformed address instead of storing it", () => {
    expect(upsert([], "0xnope", "x", 1)).toEqual([]);
  });

  it("caps the book, dropping the oldest", () => {
    // Hex-padded so every generated address is DISTINCT. Padding a decimal with
    // "1" collides (i=1 and i=11 both give forty ones), which silently tests
    // deduplication instead of the cap.
    const addr = (i: number) => `0x${i.toString(16).padStart(40, "0")}`;
    let book: ReturnType<typeof upsert> = [];
    for (let i = 0; i < MAX_ENTRIES + 5; i++) book = upsert(book, addr(i), `n${i}`, i);
    expect(book.length).toBe(MAX_ENTRIES);
    // Newest kept, oldest dropped.
    expect(book[0].address).toBe(addr(MAX_ENTRIES + 4));
    expect(book.some((e) => e.address === addr(0))).toBe(false);
  });
});

describe("remove and labelFor", () => {
  it("removes case-insensitively", () => {
    const book = upsert([], A, "One", 1);
    expect(remove(book, A.replace("0x1", "0X1"))).toEqual([]);
  });

  it("names a known address and answers null for a stranger", () => {
    const book = upsert([], A, "Cold wallet", 1);
    expect(labelFor(book, A.toUpperCase().replace("0X", "0x"))).toBe("Cold wallet");
    expect(labelFor(book, B)).toBeNull();
  });
});
