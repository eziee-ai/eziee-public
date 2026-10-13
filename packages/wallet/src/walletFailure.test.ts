import { describe, expect, it } from "vitest";
import { describeWalletFailure, readableLine } from "./walletFailure";

/**
 * The exact text viem produced on Arc, verbatim from a failing approval.
 *
 * Kept whole rather than trimmed to a snippet: what makes it unusable is its
 * SHAPE — a sentence, then calldata, two addresses, an ABI signature, a docs
 * link and two unlabelled wei figures — and a shortened fixture would test a
 * problem the user never had.
 */
const VIEM_INSUFFICIENT = `The total cost (gas * gas fee + value) of executing this transaction exceeds the balance of the account.

This error could arise when the account does not have enough funds to:
 - pay for the total gas fee,
 - pay for the value to send.
 
Request Arguments:
  from:  0xefd77a44a8DD7543B8C3BAd1d63f396cfD239A23
  to:    0x3600000000000000000000000000000000000000
  data:  0x095ea7b30000000000000000000000000106139294c3d729929a0465f79a7BF7De383174E

Contract Call:
  address:   0x3600000000000000000000000000000000000000
  function:  approve(address spender, uint256 value)
  args:      (0x106139294c3D729929a0465F79a7BF7De383174E, 115792089237316195423570985008687907853269984665640564039457584007913129639935)
  sender:    0xefd77a44a8DD7543B8C3BAd1d63f396cfD239A23

Docs: https://viem.sh/docs/contract/writeContract
Details: insufficient funds for gas * price + value: have 100000000000000 want 1426068000000000
Version: viem@2.55.0`;

describe("the error a user actually hit", () => {
  it("says what to DO, and names the chain's own fee asset", () => {
    const said = describeWalletFailure(new Error(VIEM_INSUFFICIENT), { gasSymbol: "USDC" });
    expect(said).toBe(
      "Not enough USDC in this wallet to cover the network fee. Add a little more and try again — nothing was sent.",
    );
  });

  it("still works without a symbol, rather than printing 'undefined'", () => {
    expect(describeWalletFailure(new Error(VIEM_INSUFFICIENT))).toMatch(/^Not enough in this wallet/);
  });

  it("NEVER leaks calldata, addresses or wei into the sentence", () => {
    // The whole complaint: a wall of hex rendered inside the approval card.
    // Whatever branch answers, none of this may reach a screen.
    const said = describeWalletFailure(new Error(VIEM_INSUFFICIENT), { gasSymbol: "USDC" }) ?? "";
    expect(said).not.toMatch(/0x[0-9a-fA-F]{12,}/);
    expect(said).not.toMatch(/\b\d{12,}\b/);
    expect(said).not.toMatch(/viem|Docs:|Request Arguments/);
    expect(said.length).toBeLessThan(200);
  });
});

describe("readableLine", () => {
  it("takes the first line that is PROSE, skipping the machinery", () => {
    expect(readableLine("Details: 0xdeadbeefdeadbeefdead\nSomething went wrong."))
      .toBe("Something went wrong.");
  });

  it("skips a line carrying a long hex run or a wei-sized number", () => {
    expect(readableLine("to: 0x3600000000000000000000000000000000000000")).toBeNull();
    expect(readableLine("have 100000000000000 want 1426068000000000")).toBeNull();
  });

  it("caps a long line rather than pasting a paragraph into a card", () => {
    const said = readableLine("x".repeat(400));
    expect(said).toHaveLength(180);
    expect(said?.endsWith("…")).toBe(true);
  });

  it("answers null when every line is machinery, so the caller can say something generic", () => {
    expect(readableLine("Version: viem@2.55.0\nDocs: https://viem.sh")).toBeNull();
  });
});

describe("the ended-session sentence", () => {
  it("asks for the action without naming a location", () => {
    // It reaches the withdraw panel (button beside it) and the swap flow's
    // toast (no control at all). Naming the action is true on both.
    const said = describeWalletFailure(new Error("passkey wallet is locked"), { gasSymbol: "ETH" });
    expect(said).toMatch(/sign in again/i);
    expect(said).not.toMatch(/top of the page/i);
  });

  it("still explains WHY the session ended, which is the unintuitive part", () => {
    const said = describeWalletFailure(new Error("passkey wallet is locked"), { gasSymbol: "ETH" });
    expect(said).toMatch(/reloading the page closes it/i);
  });
});
