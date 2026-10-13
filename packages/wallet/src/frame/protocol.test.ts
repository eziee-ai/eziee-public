import { describe, expect, it } from "vitest";
import {
  CHANNEL,
  ERR,
  event,
  fail,
  isEventEnvelope,
  isPresentParams,
  isRequestEnvelope,
  isRequestParams,
  isResponseEnvelope,
  isUnlockParams,
  PROTOCOL_VERSION,
  request,
  respond,
  toFrameError,
  WalletFrameError,
} from "./protocol";

/**
 * The envelope guards are the first thing a `message` event meets on both
 * sides, after the origin check. Pinned so a shape drift on one side is a
 * failing test rather than a frame that silently ignores every request.
 */

describe("envelopes", () => {
  it("round-trips a request", () => {
    const env = request("id-1", "status");
    expect(isRequestEnvelope(env)).toBe(true);
    expect(isResponseEnvelope(env)).toBe(false);
    expect(isEventEnvelope(env)).toBe(false);
  });

  it("round-trips a response and a failure", () => {
    expect(isResponseEnvelope(respond("id-1", { ok: true }))).toBe(true);
    const failed = fail("id-1", { code: ERR.LOCKED, message: "locked" });
    expect(isResponseEnvelope(failed)).toBe(true);
    expect(failed.error?.code).toBe(4100);
  });

  it("round-trips an event", () => {
    expect(isEventEnvelope(event({ event: "ready" }))).toBe(true);
  });

  it("still accepts the channel key a frame or tab loaded before 2026-10-08 sends (`iter`), and nothing else", () => {
    expect(isRequestEnvelope({ iter: CHANNEL, v: PROTOCOL_VERSION, kind: "request", id: "x", method: "status" })).toBe(true);
    expect(isRequestEnvelope({ rate: CHANNEL, v: PROTOCOL_VERSION, kind: "request", id: "x", method: "status" })).toBe(false);
  });

  it("rejects unstamped, mis-versioned and malformed data", () => {
    expect(isRequestEnvelope({ kind: "request", id: "x", method: "status" })).toBe(false);
    expect(isRequestEnvelope({ channel: CHANNEL, v: PROTOCOL_VERSION + 1, kind: "request", id: "x", method: "status" })).toBe(false);
    expect(isRequestEnvelope({ channel: CHANNEL, v: PROTOCOL_VERSION, kind: "request", method: "status" })).toBe(false);
    expect(isEventEnvelope({ channel: CHANNEL, v: PROTOCOL_VERSION, kind: "event", data: "ready" })).toBe(false);
    expect(isRequestEnvelope(null)).toBe(false);
    expect(isRequestEnvelope("string")).toBe(false);
  });
});

describe("params", () => {
  it("accepts a well-formed request", () => {
    expect(isRequestParams({ chainId: 1, rpc: { method: "personal_sign", params: [] } })).toBe(true);
  });

  it("refuses a bad chain id or an rpc with no method", () => {
    expect(isRequestParams({ chainId: 0, rpc: { method: "x" } })).toBe(false);
    expect(isRequestParams({ chainId: 1.5, rpc: { method: "x" } })).toBe(false);
    expect(isRequestParams({ chainId: "1", rpc: { method: "x" } })).toBe(false);
    expect(isRequestParams({ chainId: 1, rpc: { method: "" } })).toBe(false);
    expect(isRequestParams({ chainId: 1 })).toBe(false);
  });

  it("accepts a present with a null rpc, and demands the rest", () => {
    expect(isPresentParams({ chainId: 1, rpc: null, label: "Send", disabled: true, variant: "sheet" })).toBe(true);
    expect(isPresentParams({ chainId: 1, rpc: { method: "x" }, label: "Send", disabled: false, variant: "modal" })).toBe(true);
    expect(isPresentParams({ chainId: 1, rpc: { method: "x" }, label: "Allow once", disabled: false, variant: "card" })).toBe(true);
    expect(isPresentParams({ chainId: 1, rpc: null, label: "x", disabled: false, variant: "banner" })).toBe(false);
    expect(isPresentParams({ chainId: 1, rpc: null, label: "Send", disabled: true, variant: "huge" })).toBe(false);
    expect(isPresentParams({ chainId: 1, rpc: null, disabled: true, variant: "sheet" })).toBe(false);
  });

  it("accepts exactly 32 PRF bytes as a Uint8Array", () => {
    expect(isUnlockParams({ prfOutput: new Uint8Array(32) })).toBe(true);
    expect(isUnlockParams({ prfOutput: new Uint8Array(31) })).toBe(false);
    expect(isUnlockParams({ prfOutput: Array.from(new Uint8Array(32)) })).toBe(false);
  });
});

describe("toFrameError", () => {
  it("keeps a frame error's code", () => {
    expect(toFrameError(new WalletFrameError({ code: ERR.CONFIRM_REQUIRED, message: "confirm" }))).toEqual({
      code: 4300,
      message: "confirm",
    });
  });

  it("reads an EIP-1193 code off the error or its cause", () => {
    expect(toFrameError(Object.assign(new Error("no"), { code: 4001 })).code).toBe(4001);
    const wrapped = new Error("outer", { cause: Object.assign(new Error("inner"), { code: 4001 }) });
    expect(toFrameError(wrapped)).toEqual({ code: 4001, message: "inner" });
  });

  it("treats viem's UserRejectedRequestError as a rejection", () => {
    const err = Object.assign(new Error("User rejected"), { name: "UserRejectedRequestError" });
    expect(toFrameError(err).code).toBe(4001);
  });

  it("falls back to internal, with the innermost message", () => {
    const err = new Error("Passkey operation failed", { cause: new Error("the real reason") });
    expect(toFrameError(err)).toEqual({ code: -32603, message: "the real reason" });
  });

  it("stringifies a non-error", () => {
    expect(toFrameError("boom")).toEqual({ code: -32603, message: "boom" });
  });

  it("keeps the message of a thrown plain FrameError literal", () => {
    // The host throws `CONFIRM_REQUIRED_ERROR` as a literal; a live probe found
    // it arriving as "[object Object]".
    expect(toFrameError({ code: ERR.CONFIRM_REQUIRED, message: "needs the confirm control" })).toEqual({
      code: 4300,
      message: "needs the confirm control",
    });
  });
});
