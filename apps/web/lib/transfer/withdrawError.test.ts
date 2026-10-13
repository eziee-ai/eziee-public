import { BRAND } from "@repo/ui/brand";
import { describe, expect, it } from "vitest";
import {
  describeWithdrawBlock,
  describeWithdrawFailure,
  isWithdrawDecision,
  withdrawNeedsSignIn,
} from "./withdrawError";

describe("isWithdrawDecision", () => {
  it("recognises a declined prompt", () => {
    expect(isWithdrawDecision({ code: 4001, message: "nope" })).toBe(true);
    expect(isWithdrawDecision(new Error("User rejected the request"))).toBe(true);
    expect(isWithdrawDecision(new Error("user denied transaction signature"))).toBe(true);
  });

  it("does NOT swallow a failure that merely contains the word cancel", () => {
    // The old test was /reject|denied|cancel/i over the message, so an RPC
    // reporting a cancelled request read as the user changing their mind and
    // the withdrawal failed in silence.
    expect(isWithdrawDecision(new Error("request cancelled by upstream"))).toBe(false);
  });

  it("does NOT treat NotAllowedError as a decision", () => {
    // WebAuthn raises it for a dismissed prompt AND for one the browser refused
    // to show. Counting it as a decision hides the second case entirely.
    const err = Object.assign(new Error("The operation is not allowed"), {
      name: "NotAllowedError",
    });
    expect(isWithdrawDecision(err)).toBe(false);
  });
});

describe("describeWithdrawFailure", () => {
  it("says nothing for a decision", () => {
    expect(describeWithdrawFailure({ code: 4001 })).toBeNull();
  });

  it("explains a locked passkey as an ended session, not a fault", () => {
    // meraConnector.getProvider throws exactly this string, and it is the most
    // likely failure on this screen: a reload ends the session by design.
    const said = describeWithdrawFailure(new Error("Passkey wallet is locked."));
    expect(said).toMatch(/session has ended/i);
    expect(said).toMatch(/sign in again/i);
  });

  it("names BOTH readings of a NotAllowedError", () => {
    const err = Object.assign(new Error("NotAllowedError"), { name: "NotAllowedError" });
    const said = describeWithdrawFailure(err);
    expect(said).toMatch(/dismissed/i);
    expect(said).toMatch(/never appeared/i);
  });

  it("prefers the CAUSE over a wrapper that says nothing", () => {
    // mera replaces the message on anything it wraps, so the wrapper's text is
    // the one sentence guaranteed not to explain the failure.
    const err = Object.assign(new Error("Passkey operation failed"), {
      cause: new Error("The authenticator has no credential for this domain"),
    });
    expect(describeWithdrawFailure(err)).toBe(
      "The authenticator has no credential for this domain",
    );
  });

  it("falls back to the error's own message, and never to an empty string", () => {
    // NOT "insufficient funds …" any more — that has its own sentence now, and
    // using it here was testing the fallback with a value that no longer
    // reaches it.
    expect(describeWithdrawFailure(new Error("nonce too low"))).toBe("nonce too low");
    expect(describeWithdrawFailure(new Error(""))).toBe(
      "The wallet could not complete that. Try again in a moment.",
    );
  });
});

describe("describeWithdrawBlock", () => {
  it("names what is missing rather than returning silently", () => {
    // The handler's first line used to be `if (!chain || parsed === null) return`,
    // which is the same screen as a button that does not work.
    expect(
      describeWithdrawBlock({ hasChain: false, hasAmount: true, hasAccount: true }),
    ).toMatch(/no network/i);
    expect(
      describeWithdrawBlock({ hasChain: true, hasAmount: false, hasAccount: true }),
    ).toMatch(/amount/i);
    expect(
      describeWithdrawBlock({ hasChain: false, hasAmount: false, hasAccount: false }),
    ).toMatch(/signed in/i);
  });

  it("is null when everything it checks is present", () => {
    expect(
      describeWithdrawBlock({ hasChain: true, hasAmount: true, hasAccount: true }),
    ).toBeNull();
  });
});

describe("a rate-limited RPC", () => {
  it("is recognised by STATUS, wherever it sits in the cause chain", () => {
    // viem nests: the TransactionExecutionError the caller catches carries an
    // HttpRequestError several levels down, and only that one has `status`.
    const http = Object.assign(new Error("HTTP request failed."), { status: 429 });
    const wrapped = Object.assign(new Error("An unknown error occurred."), {
      cause: Object.assign(new Error("The request failed."), { cause: http }),
    });
    const said = describeWithdrawFailure(wrapped);
    expect(said).toMatch(/429/);
    expect(said).toMatch(/nothing was sent/i);
  });

  it("is recognised by wording too, for a transport that reports no status", () => {
    expect(describeWithdrawFailure(new Error("Too Many Requests"))).toMatch(/429/);
    expect(describeWithdrawFailure(new Error("rate limit exceeded"))).toMatch(/429/);
  });

  it("does not fire on an unrelated number that merely contains 429", () => {
    // The word boundary matters: an amount or a block height should not be read
    // as a status code.
    const said = describeWithdrawFailure(new Error("nonce too low: next nonce 4291"));
    expect(said).toBe("nonce too low: next nonce 4291");
  });
});

describe("withdrawNeedsSignIn", () => {
  it("is true only for the ended session, which is the one with a remedy", () => {
    expect(withdrawNeedsSignIn(new Error("Passkey wallet is locked."))).toBe(true);
    expect(withdrawNeedsSignIn(new Error("insufficient funds for gas"))).toBe(false);
    expect(withdrawNeedsSignIn({ code: 4001 })).toBe(false);
  });
});

describe("sign-in copy names an action, never a place", () => {
  it("does not tell the user where a button is", () => {
    /*
     * These sentences reach surfaces that differ in whether a control sits
     * beside them: the withdraw panel renders a Sign in button, the swap flow
     * shows a toast with none. "At the top of the page" was wrong for the first
     * (the button is right there) and unreliable for the second, since
     * AppShell's chrome is hidden below 1200px — so on a narrow viewport it
     * pointed at nothing.
     */
    const blocked = describeWithdrawBlock({ hasChain: true, hasAmount: true, hasAccount: false });
    expect(blocked).toBeTruthy();
    expect(blocked).not.toMatch(/top of the page/i);
    expect(blocked).toContain(`No ${BRAND} account is signed in`);
  });

  it("still says WHAT is wrong, not merely that something is", () => {
    // Trimming the direction must not trim the diagnosis with it.
    expect(describeWithdrawBlock({ hasChain: true, hasAmount: true, hasAccount: false })).toMatch(
      /nothing to send from/i,
    );
  });
});
