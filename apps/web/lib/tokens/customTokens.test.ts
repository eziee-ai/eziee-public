import { getAddress } from "viem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addCustomToken, customTokensKey, listCustomTokens, parseCustomTokens, removeCustomToken, type CustomToken } from "./customTokens";
import { installStorage, removeStorage } from "./testStorage";
import { readPrefs, tokenPrefsKey, togglePin } from "./tokenPrefs";

const ARC = 5042002;
const ACCOUNT = "0xAbCdEf0123456789aBcDeF0123456789abCDef01";
const TOKEN: CustomToken = { address: "0x1111111111111111111111111111111111111111", symbol: "TEST", name: "Test Token", decimals: 6 };

describe("custom tokens", () => {
  beforeEach(() => installStorage());
  afterEach(() => removeStorage());

  it("keys the store by chain and lowercased account", () => {
    expect(customTokensKey(ARC, ACCOUNT)).toBe(`eziee:tokens:${ARC}:${ACCOUNT.toLowerCase()}`);
  });

  it("round-trips an added token, per chain and per account", () => {
    expect(listCustomTokens(ARC, ACCOUNT)).toEqual([]);
    expect(addCustomToken(ARC, ACCOUNT, TOKEN)).toBe(true);
    expect(listCustomTokens(ARC, ACCOUNT)).toEqual([TOKEN]);
    // The same account in another case is the same wallet.
    expect(listCustomTokens(ARC, ACCOUNT.toLowerCase())).toEqual([TOKEN]);
    expect(listCustomTokens(11155931, ACCOUNT)).toEqual([]);
    expect(listCustomTokens(ARC, "0x2222222222222222222222222222222222222222")).toEqual([]);
  });

  it("does not add the same address twice", () => {
    addCustomToken(ARC, ACCOUNT, TOKEN);
    addCustomToken(ARC, ACCOUNT, { ...TOKEN, address: TOKEN.address.toUpperCase().replace("0X", "0x") as CustomToken["address"] });
    expect(listCustomTokens(ARC, ACCOUNT)).toHaveLength(1);
  });

  it("removes a token by address, in any case", () => {
    addCustomToken(ARC, ACCOUNT, TOKEN);
    removeCustomToken(ARC, ACCOUNT, TOKEN.address.toUpperCase());
    expect(listCustomTokens(ARC, ACCOUNT)).toEqual([]);
  });

  it("forgets a removed token's pin and hide, and no other token's", () => {
    const data = installStorage();
    const other = "0x2222222222222222222222222222222222222222";
    addCustomToken(ARC, ACCOUNT, TOKEN);
    data.set(tokenPrefsKey(ARC, ACCOUNT), JSON.stringify({ pinned: [TOKEN.address, other], hidden: [TOKEN.address, "native"] }));
    expect(removeCustomToken(ARC, ACCOUNT, TOKEN.address.toUpperCase().replace("0X", "0x"))).toBe(true);
    expect(readPrefs(ARC, ACCOUNT)).toEqual({ pinned: [other], hidden: ["native"] });
  });

  it("writes no prefs when the removed token had none", () => {
    const data = installStorage();
    addCustomToken(ARC, ACCOUNT, TOKEN);
    togglePin(ARC, ACCOUNT, "native");
    const before = data.get(tokenPrefsKey(ARC, ACCOUNT));
    removeCustomToken(ARC, ACCOUNT, TOKEN.address);
    expect(data.get(tokenPrefsKey(ARC, ACCOUNT))).toBe(before);
    removeCustomToken(11155931, ACCOUNT, TOKEN.address);
    expect(data.has(tokenPrefsKey(11155931, ACCOUNT))).toBe(false);
  });

  it("returns the same array while storage is unchanged, so a subscriber does not loop", () => {
    addCustomToken(ARC, ACCOUNT, TOKEN);
    expect(listCustomTokens(ARC, ACCOUNT)).toBe(listCustomTokens(ARC, ACCOUNT));
  });

  it("refuses to store a token that is not well formed", () => {
    expect(addCustomToken(ARC, ACCOUNT, { ...TOKEN, decimals: 37 })).toBe(false);
    expect(addCustomToken(ARC, ACCOUNT, { ...TOKEN, address: "0x1234" as CustomToken["address"] })).toBe(false);
    expect(addCustomToken(ARC, ACCOUNT, { ...TOKEN, symbol: "   " })).toBe(false);
    expect(listCustomTokens(ARC, ACCOUNT)).toEqual([]);
  });

  it("drops bad entries on the way out of storage", () => {
    const raw = JSON.stringify([TOKEN, { ...TOKEN, address: "0xnope" }, { ...TOKEN, address: "0x3333333333333333333333333333333333333333", decimals: 1.5 }, null, "x", { ...TOKEN, symbol: "A\u202eB" }]);
    const parsed = parseCustomTokens(raw);
    expect(parsed.map((t) => t.address)).toEqual([TOKEN.address]);
    expect(parseCustomTokens("not json")).toEqual([]);
    expect(parseCustomTokens(null)).toEqual([]);
  });

  it("checksums stored addresses", () => {
    const lower = "0xabcdef0123456789abcdef0123456789abcdef01";
    const [token] = parseCustomTokens(JSON.stringify([{ ...TOKEN, address: lower }]));
    expect(token?.address).toBe(getAddress(lower));
  });

  it("works without storage at all", () => {
    removeStorage({ throwing: true });
    expect(listCustomTokens(ARC, ACCOUNT)).toEqual([]);
    // The write cannot persist, but it still applies to this page.
    expect(addCustomToken(ARC, ACCOUNT, TOKEN)).toBe(false);
    expect(listCustomTokens(ARC, ACCOUNT)).toEqual([TOKEN]);
  });

  it("shows a write that failed on quota, even over an older stored value", () => {
    const data = installStorage();
    addCustomToken(ARC, ACCOUNT, TOKEN);
    const storage = globalThis.localStorage as Storage;
    storage.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    const second = { ...TOKEN, address: "0x2222222222222222222222222222222222222222" as CustomToken["address"], symbol: "TWO" };
    expect(addCustomToken(ARC, ACCOUNT, second)).toBe(false);
    expect(listCustomTokens(ARC, ACCOUNT).map((t) => t.symbol)).toEqual(["TEST", "TWO"]);
    expect(data.get(customTokensKey(ARC, ACCOUNT))).toContain("TEST");
  });
});
