"use client";

/**
 * The hidden frame's side of the protocol.
 *
 * Runs inside `<walletOrigin>/wallet-frame`, embedded invisibly by the app.
 * It answers exactly five methods (`protocol.ts`), for exactly one sender —
 * the window that embedded it, on the one origin `appOrigin()` names — and it
 * refuses the confirm tier outright: a value-moving request on this path is
 * answered with `CONFIRM_REQUIRED` and never signed, whatever the caller says
 * about it. The visible confirm frame is the only way those get signed.
 *
 * ## Why `event.source === window.parent` as well as the origin
 *
 * The origin check is the boundary. The source check is belt and braces
 * against the app origin holding more than one window that can reach this
 * frame — a popup the app opened, say — so that only the document that
 * embedded the frame can drive it.
 *
 * ## Stateless between requests
 *
 * Nothing is cached here. Status reads storage, resume and every signature
 * restore from storage, and a disconnect wipes storage. The frame can be
 * reloaded at any time and answers the same.
 */

import { appOrigins, isAllowedAppOrigin } from "./origins";
import { evaluate } from "./evaluate";
import { CONFIRM_REQUIRED_ERROR } from "./policy";
import {
  ERR,
  event,
  fail,
  isRequestEnvelope,
  isRequestParams,
  isUnlockParams,
  respond,
  toFrameError,
  type FrameError,
  type RequestEnvelope,
} from "./protocol";
import { endSession, executeSigned, resumeSession, sessionStatus, unlockSession } from "./signer";

const invalid = (message: string): FrameError => ({ code: ERR.INVALID_PARAMS, message });

/** `origin` is the browser's own report of who sent the message (`MessageEvent.origin`), already checked against the allowed app origins. */
async function handle(envelope: RequestEnvelope, origin: string): Promise<unknown> {
  switch (envelope.method) {
    case "status":
      return sessionStatus();

    case "resume":
      return { address: await resumeSession() };

    case "unlock": {
      if (!isUnlockParams(envelope.params)) throw invalid("unlock needs 32 PRF bytes");
      return { address: await unlockSession(envelope.params.prfOutput) };
    }

    case "request": {
      if (!isRequestParams(envelope.params)) throw invalid("request needs a chainId and an rpc");
      const { chainId, rpc } = envelope.params;
      // The account the rules are weighed for is the frame's OWN session, never one the app names.
      const status = sessionStatus();
      const account = status.address;
      if (!account) throw { code: ERR.LOCKED, message: "The passkey session has expired. Connect again to unlock it." } satisfies FrameError;
      const verdict = await evaluate(chainId, rpc, { account, now: Date.now(), sessionKey: status.expiresAt, origin });
      if (verdict.tier !== "session") throw CONFIRM_REQUIRED_ERROR;
      return executeSigned(chainId, rpc);
    }

    case "disconnect":
      endSession();
      return { ok: true };

    default:
      throw { code: ERR.UNSUPPORTED, message: `Unknown frame method ${String(envelope.method)}` } satisfies FrameError;
  }
}

/**
 * Start answering. Returns the stop function, for React's effect cleanup.
 *
 * A frame that is not embedded (opened directly in a tab) has `window.parent
 * === window` and starts nothing: there is nobody to answer and no reason to
 * announce readiness to itself.
 */
export function startWalletFrameHost(): () => void {
  if (typeof window === "undefined" || window.parent === window) return () => {};

  const parent = window.parent;

  const onMessage = (e: MessageEvent) => {
    if (!isAllowedAppOrigin(e.origin) || e.source !== parent) return;
    if (!isRequestEnvelope(e.data)) return;
    const envelope = e.data;
    // Answer the origin that asked, never a default: with several allowed
    // origins, a reply addressed to the wrong one is dropped by the browser.
    const replyTo = e.origin;

    void handle(envelope, replyTo).then(
      (result) => parent.postMessage(respond(envelope.id, result), replyTo),
      (err: unknown) => parent.postMessage(fail(envelope.id, toFrameError(err)), replyTo),
    );
  };

  window.addEventListener("message", onMessage);
  // Readiness goes to every allowed origin; the one that embedded us hears it
  // and the browser discards the rest. No origin is learned from the parent.
  for (const origin of appOrigins()) parent.postMessage(event({ event: "ready" }), origin);

  return () => window.removeEventListener("message", onMessage);
}
