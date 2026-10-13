import { describe, expect, it } from "vitest";
import { isPlausibleAddress, isSelfSend } from "./withdraw";

/**
 * The two guards on an irreversible transfer.
 *
 * Neither can tell whether a destination is one the user controls — nothing can,
 * and pretending otherwise would be the wrong kind of reassurance. What they
 * catch is the mistake that actually happens.
 */
describe("isPlausibleAddress", () => {
  it("rejects the TRUNCATED form this app displays everywhere", () => {
    // Every address in the UI renders as `0x38A1…7f0A`, so pasting one back is
    // the realistic error — and it looks almost right.
    expect(isPlausibleAddress("0x38A1…7f0A")).toBe(false);
    expect(isPlausibleAddress("0x38A11090D36eFFb75f7b8414794Cd4569ff97f0A")).toBe(true);
  });

  it("rejects near-misses that a length check alone would pass", () => {
    const good = "0x38A11090D36eFFb75f7b8414794Cd4569ff97f0A";
    expect(isPlausibleAddress(good.slice(0, -1))).toBe(false); // 39 nibbles
    expect(isPlausibleAddress(`${good}0`)).toBe(false); // 41
    expect(isPlausibleAddress(good.replace("0x", ""))).toBe(false); // no prefix
    expect(isPlausibleAddress(good.replace("A", "Z"))).toBe(false); // not hex
  });

  it("tolerates surrounding whitespace, which a paste brings with it", () => {
    expect(isPlausibleAddress("  0x38A11090D36eFFb75f7b8414794Cd4569ff97f0A \n")).toBe(true);
  });
});

describe("isSelfSend", () => {
  it("catches sending to the wallet it is leaving, whatever the casing", () => {
    // It would succeed, cost a fee and change nothing — which reads as a bug
    // rather than as the no-op it is.
    const me = "0x9E7A01E4514bb56ae642587E0485b606DB46850E";
    expect(isSelfSend(me, me.toLowerCase())).toBe(true);
    expect(isSelfSend(me, ` ${me.toUpperCase()} `)).toBe(true);
    expect(isSelfSend(me, "0x38A11090D36eFFb75f7b8414794Cd4569ff97f0A")).toBe(false);
  });

  it("says no when there is no connected wallet to compare against", () => {
    expect(isSelfSend(undefined, "0x38A11090D36eFFb75f7b8414794Cd4569ff97f0A")).toBe(false);
  });
});
