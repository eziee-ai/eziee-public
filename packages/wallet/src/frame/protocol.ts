/**
 * The wire between the app and the wallet frame.
 *
 * Two documents on two origins talk over `postMessage`: the app on its origin,
 * and the frame on the wallet origin (`lib/wallet/frame/origins.ts`). This
 * file is the only thing both sides import, so the shape of a message is
 * defined once and a change here is a change to both ends.
 *
 * ## Everything that arrives is data
 *
 * A `message` event can be posted by any window that can obtain a reference
 * to the target — the app's parent, a popup, an extension. Both sides check
 * `event.origin` and `event.source` before looking inside, and both sides
 * then VALIDATE the shape with the guards below rather than trusting a cast.
 * A malformed envelope is ignored, never answered: answering tells a sender
 * that something is listening.
 *
 * ## Error codes are EIP-1193's where one fits
 *
 * `4001` (user rejected) and `4100` (unauthorized) are the codes wagmi and
 * viem already recognise, so `lib/wallet/index.ts`'s cancellation test and
 * `withdrawError.ts`'s "sign in again" test both work on a frame error
 * unchanged. `4300` is this protocol's own: a request the frame refuses to
 * sign silently because it moves value, which the caller must instead route
 * through the visible confirm frame (`components/Wallet/WalletConfirmFrame`).
 * Raising it as an error rather than quietly executing is the design: a
 * caller that forgot the confirm step gets a loud failure, not a silent drain.
 */

import type { Address, Hex } from "viem";

/** Stamped on every envelope so unrelated `message` traffic is ignored cheaply. */
export const CHANNEL = "wlt.wallet-frame" as const;

/** The version of this protocol. Bump when an envelope's shape changes. */
export const PROTOCOL_VERSION = 1 as const;

export const ERR = {
  USER_REJECTED: 4001,
  /** No session to sign with — expired, disconnected, or never unlocked. */
  LOCKED: 4100,
  /** A method the frame does not implement. */
  UNSUPPORTED: 4200,
  /** Refused on the silent path: this request needs the visible confirm frame. */
  CONFIRM_REQUIRED: 4300,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
} as const;

export interface FrameError {
  code: number;
  message: string;
}

/** An error the app side raises for a frame failure, carrying the EIP-1193 code. */
export class WalletFrameError extends Error {
  readonly code: number;
  constructor(error: FrameError) {
    super(error.message);
    this.name = "WalletFrameError";
    this.code = error.code;
  }
}

/** An EIP-1193 request, as the connector's provider receives it. */
export interface WalletRpc {
  method: string;
  params?: unknown;
}

/** What the hidden frame can be asked. */
export type FrameMethod = "status" | "resume" | "unlock" | "request" | "disconnect";

export interface StatusResult {
  /** The address a stored session belongs to, or null when nothing can sign. */
  address: Address | null;
  /** When that session stops resuming. Null with no session. */
  expiresAt: number | null;
}

export interface UnlockParams {
  /** The 32 PRF bytes straight from the ceremony. Zeroed by the sender after the call. */
  prfOutput: Uint8Array;
}

export interface RequestParams {
  chainId: number;
  rpc: WalletRpc;
}

/** What the visible confirm frame is asked to show and, on the user's click, sign. */
export interface PresentParams {
  chainId: number;
  /** Null while the caller has nothing ready to sign; the button renders inert. */
  rpc: WalletRpc | null;
  /** The button's text, so the frame can render the caller's own wording. */
  label: string;
  /** Renders the button inert. The caller's pre-checks decide this. */
  disabled: boolean;
  /** Which of the app's two button shapes to draw, so the control matches its surroundings. */
  /**
   * `card`: the full permission card (restatement, Deny, Allow once, Always allow…), used for
   * protocol actions in the chat. `sheet` and `modal` stay a single confirm button.
   */
  variant: "sheet" | "modal" | "card";
}

export interface RequestEnvelope {
  channel: typeof CHANNEL;
  v: typeof PROTOCOL_VERSION;
  kind: "request";
  id: string;
  method: FrameMethod | "present";
  params?: unknown;
}

export interface ResponseEnvelope {
  channel: typeof CHANNEL;
  v: typeof PROTOCOL_VERSION;
  kind: "response";
  id: string;
  result?: unknown;
  error?: FrameError;
}

/** Unsolicited, frame → app. */
export type FrameEvent =
  | { event: "ready" }
  | { event: "submitted"; hash: Hex }
  | { event: "failed"; error: FrameError }
  | { event: "size"; height: number };

export interface EventEnvelope {
  channel: typeof CHANNEL;
  v: typeof PROTOCOL_VERSION;
  kind: "event";
  data: FrameEvent;
}

export type Envelope = RequestEnvelope | ResponseEnvelope | EventEnvelope;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStamped(value: unknown): value is Record<string, unknown> & { kind: string } {
  return (
    isRecord(value) &&
    // `iter` was the key before 2026-10-08; a frame or tab loaded before then still sends it.
    (value.channel === CHANNEL || value.iter === CHANNEL) &&
    value.v === PROTOCOL_VERSION &&
    typeof value.kind === "string"
  );
}

export function isRequestEnvelope(value: unknown): value is RequestEnvelope {
  return (
    isStamped(value) &&
    value.kind === "request" &&
    typeof value.id === "string" &&
    typeof value.method === "string"
  );
}

export function isResponseEnvelope(value: unknown): value is ResponseEnvelope {
  return isStamped(value) && value.kind === "response" && typeof value.id === "string";
}

export function isEventEnvelope(value: unknown): value is EventEnvelope {
  if (!isStamped(value) || value.kind !== "event" || !isRecord(value.data)) return false;
  return typeof value.data.event === "string";
}

const HEX = /^0x[0-9a-fA-F]*$/;

export function isHex(value: unknown): value is Hex {
  return typeof value === "string" && HEX.test(value);
}

export function isAddressLike(value: unknown): value is Address {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

/** A `WalletRpc` as posted: a method name and whatever params came with it. */
export function isWalletRpc(value: unknown): value is WalletRpc {
  return isRecord(value) && typeof value.method === "string" && value.method.length > 0;
}

export function isRequestParams(value: unknown): value is RequestParams {
  return (
    isRecord(value) &&
    typeof value.chainId === "number" &&
    Number.isInteger(value.chainId) &&
    value.chainId > 0 &&
    isWalletRpc(value.rpc)
  );
}

export function isPresentParams(value: unknown): value is PresentParams {
  if (!isRecord(value)) return false;
  return (
    typeof value.chainId === "number" &&
    Number.isInteger(value.chainId) &&
    value.chainId > 0 &&
    (value.rpc === null || isWalletRpc(value.rpc)) &&
    typeof value.label === "string" &&
    typeof value.disabled === "boolean" &&
    (value.variant === "sheet" || value.variant === "modal" || value.variant === "card")
  );
}

export function isUnlockParams(value: unknown): value is UnlockParams {
  return isRecord(value) && value.prfOutput instanceof Uint8Array && value.prfOutput.length === 32;
}

export function request(id: string, method: RequestEnvelope["method"], params?: unknown): RequestEnvelope {
  return { channel: CHANNEL, v: PROTOCOL_VERSION, kind: "request", id, method, params };
}

export function respond(id: string, result: unknown): ResponseEnvelope {
  return { channel: CHANNEL, v: PROTOCOL_VERSION, kind: "response", id, result };
}

export function fail(id: string, error: FrameError): ResponseEnvelope {
  return { channel: CHANNEL, v: PROTOCOL_VERSION, kind: "response", id, error };
}

export function event(data: FrameEvent): EventEnvelope {
  return { channel: CHANNEL, v: PROTOCOL_VERSION, kind: "event", data };
}

/**
 * Reduce any thrown value to a `FrameError` that survives `postMessage`.
 *
 * An `Error` does not structured-clone with its custom fields, and a viem
 * error carries a `cause` chain and a `walk()` that certainly do not. So the
 * code is read off the object here and the message is the innermost one on
 * the chain — the same rule `describeConnectError` follows, because the
 * outer message on a wrapped error is usually the least informative.
 */
export function toFrameError(err: unknown, fallback: number = ERR.INTERNAL): FrameError {
  if (err instanceof WalletFrameError) return { code: err.code, message: err.message };

  const e = err as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown };
  let code: number = fallback;
  if (typeof e?.code === "number") code = e.code;
  else if (isRecord(e?.cause) && typeof e.cause.code === "number") code = e.cause.code;
  else if (e?.name === "UserRejectedRequestError") code = ERR.USER_REJECTED;
  else if (
    typeof DOMException !== "undefined" &&
    err instanceof DOMException &&
    (err.name === "NotAllowedError" || err.name === "AbortError")
  ) {
    code = ERR.USER_REJECTED;
  }

  // A thrown `FrameError` literal is a plain object: read its message rather
  // than stringifying it to "[object Object]", which is what a probe found.
  let message = err instanceof Error ? err.message : typeof e?.message === "string" ? e.message : String(err);
  let cur: unknown = e?.cause;
  for (let i = 0; i < 5 && cur; i++) {
    if (cur instanceof Error && cur.message) message = cur.message;
    cur = (cur as { cause?: unknown })?.cause;
  }
  return { code, message };
}
