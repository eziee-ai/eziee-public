import { describe, it, expect } from "vitest";
import { depositUri } from "./gasDeposit";

/**
 * The QR payload is the one value on that sheet that must never be wrong: a mobile wallet
 * acts on it directly, and a send on the wrong network is accepted by that network and
 * unrecoverable from here.
 */
describe("depositUri", () => {
  const ADDRESS = "0x1ABE6d936A198B7B24842d53e480e06002180784";

  it("carries the chain id, so a wallet does not have to guess the network", () => {
    expect(depositUri(ADDRESS, 5042002)).toBe(`ethereum:${ADDRESS}@5042002`);
    expect(depositUri(ADDRESS, 11155931)).toBe(`ethereum:${ADDRESS}@11155931`);
  });

  it("still produces a scannable URI without a chain", () => {
    // Degrades to the address alone rather than to nothing — the wallet then asks which
    // network, which is a question, not a loss.
    expect(depositUri(ADDRESS)).toBe(`ethereum:${ADDRESS}`);
  });

  it("never emits a bare address, which would carry no network at all", () => {
    // A naive QR contains just the address, and a phone wallet defaulting to mainnet then
    // sends real funds to a testnet-only account. The scheme prefix is what stops that.
    for (const chainId of [5042002, undefined]) {
      expect(depositUri(ADDRESS, chainId).startsWith("ethereum:")).toBe(true);
    }
  });

  it("encodes no amount", () => {
    // The fee is cents and the user may want more than one transaction's worth; a
    // prefilled amount would be a number this module cannot know.
    expect(depositUri(ADDRESS, 5042002)).not.toContain("value");
    expect(depositUri(ADDRESS, 5042002)).not.toContain("amount");
  });
});
