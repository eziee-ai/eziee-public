import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parsePrefs, readPrefs, tokenPrefsKey, togglePin, toggleHide } from "./tokenPrefs";
import { installStorage, removeStorage } from "./testStorage";

const ARC = 5042002;
const ACCOUNT = "0xAbCdEf0123456789aBcDeF0123456789abCDef01";
const USDC = "0x3600000000000000000000000000000000000000";
const OTHER = "0x1111111111111111111111111111111111111111";

describe("token preferences", () => {
  beforeEach(() => installStorage());
  afterEach(() => removeStorage());

  it("keys the store by chain and lowercased account", () => {
    expect(tokenPrefsKey(ARC, ACCOUNT)).toBe(`eziee:token-prefs:${ARC}:${ACCOUNT.toLowerCase()}`);
  });

  it("starts empty", () => {
    expect(readPrefs(ARC, ACCOUNT)).toEqual({ pinned: [], hidden: [] });
  });

  it("toggles a pin on and off, by lowercased address", () => {
    togglePin(ARC, ACCOUNT, USDC.toUpperCase().replace("0X", "0x"));
    expect(readPrefs(ARC, ACCOUNT).pinned).toEqual([USDC]);
    togglePin(ARC, ACCOUNT, USDC);
    expect(readPrefs(ARC, ACCOUNT).pinned).toEqual([]);
  });

  it("keeps the native asset as its own id", () => {
    togglePin(ARC, ACCOUNT, "native");
    expect(readPrefs(ARC, ACCOUNT).pinned).toEqual(["native"]);
  });

  it("hiding a pinned token unpins it, and pinning a hidden one shows it", () => {
    togglePin(ARC, ACCOUNT, USDC);
    toggleHide(ARC, ACCOUNT, USDC);
    expect(readPrefs(ARC, ACCOUNT)).toEqual({ pinned: [], hidden: [USDC] });
    togglePin(ARC, ACCOUNT, USDC);
    expect(readPrefs(ARC, ACCOUNT)).toEqual({ pinned: [USDC], hidden: [] });
  });

  it("keeps each chain and account apart", () => {
    toggleHide(ARC, ACCOUNT, OTHER);
    expect(readPrefs(11155931, ACCOUNT).hidden).toEqual([]);
    expect(readPrefs(ARC, OTHER).hidden).toEqual([]);
  });

  it("returns the same object while storage is unchanged", () => {
    togglePin(ARC, ACCOUNT, USDC);
    expect(readPrefs(ARC, ACCOUNT)).toBe(readPrefs(ARC, ACCOUNT));
  });

  it("drops anything that is not a token id", () => {
    expect(parsePrefs(JSON.stringify({ pinned: [USDC, "0xnope", 5, "native", USDC], hidden: "x" }))).toEqual({ pinned: [USDC, "native"], hidden: [] });
    expect(parsePrefs("{")).toEqual({ pinned: [], hidden: [] });
    expect(parsePrefs(null)).toEqual({ pinned: [], hidden: [] });
  });

  it("still applies on this page when storage is blocked", () => {
    removeStorage({ throwing: true });
    expect(togglePin(ARC, ACCOUNT, USDC)).toBe(false);
    expect(readPrefs(ARC, ACCOUNT).pinned).toEqual([USDC]);
  });
});
