"use client";

/**
 * The passkey ceremony, on the APP origin.
 *
 * A passkey's WebAuthn PRF output is 32 secret bytes, and mera treats them as
 * a secp256k1 private key. This module runs the ceremony and returns those
 * bytes to the connector, which hands them straight to the wallet frame
 * (`lib/wallet/frame`) and zeroes its copy. That is the whole of what the
 * app origin does with the key now:
 *
 *   - it does NOT derive the address — the frame does;
 *   - it does NOT persist the key — the frame does, on its own origin, under
 *     a non-extractable wrapping key (`meraSession.ts`);
 *   - it does NOT sign — every signature is a request to the frame, which
 *     decides whether the request may be signed silently (`frame/policy.ts`).
 *
 * ## Why the ceremony stays here rather than moving into the frame
 *
 * WebAuthn in a cross-origin iframe needs a user gesture INSIDE that frame,
 * and the app has thirteen "Connect" entry points that are ordinary buttons on
 * the app's own origin. Moving the ceremony would turn each of those into a
 * two-step (open a dialog, click again inside the frame), and the brief for
 * this change was that nothing about the experience moves. So the tap
 * happens exactly where it did, and the bytes leave this origin one
 * `postMessage` later.
 *
 * Read that trade honestly: script on example.com that is present at the moment
 * of the tap can hook `navigator.credentials.get` and read the PRF output.
 * Script present at any OTHER moment — which is every moment for the 24 hours
 * a session lasts — gets nothing, where before it got the key from storage.
 * Closing the remaining window means the click has to land on the wallet
 * origin, which is the dialog-only design recorded in the custody doc.
 *
 * ## What is a pointer, and stays here
 *
 * The credential POINTER — credential id, transports, salt — in localStorage
 * in the clear, on THIS origin. None of it can produce a key without the
 * authenticator; all of it is needed to ask for the same PRF output again.
 * Losing it does not lose the account, it just means picking the passkey
 * from a list. It stays on the app origin because the ceremony that needs it
 * does.
 *
 * ## The salt is load-bearing and must never change
 *
 * Same passkey + same salt ⇒ same 32 bytes ⇒ same private key ⇒ same address.
 * Change `PRF_SALT` and every existing user silently gets a NEW address, with
 * their funds stranded at the old one and no error anywhere. It is stored
 * alongside the credential rather than assumed, so a future rotation is a
 * deliberate migration instead of an accident.
 *
 * ## Passkeys are origin-bound, and that is visible in the address
 *
 * WebAuthn scopes a credential to an rpId — this origin's hostname. `localhost`
 * and `example.com` are different origins, so the same human gets DIFFERENT
 * accounts on each. The wallet frame's origin plays no part in this: the
 * ceremony is here, so the rpId is the app's.
 *
 * ## Mera is 0.2.0 / preview
 *
 * This is key derivation: a defect loses funds irreversibly and silently. The
 * version is pinned and the module is kept small and readable for that reason.
 */

import {
  MeraError,
  createPasskeyWithPrfOutput,
  getPasskeyPrfOutput,
  type PasskeyCredentialTransport,
} from "@category-labs/mera";
import { hintedWebAuthnClient, prfKnownUnavailable } from "./webauthnClient";
import { walletFrame } from "./frame/client";
import { walletConfig } from "./config";

/** Storage key. Has a row in /cookies, as every key in this app must. */
const CREDENTIAL_KEY = "wlt.mera-credential";

/**
 * The PRF salt. Fixed, versioned in the name, and never edited in place — see
 * the header: changing it re-derives every user onto a new address.
 */
const PRF_SALT = new TextEncoder().encode("wlt1.mera.v1.secp256k1.account\0\0");

type StoredCredential = {
  v: 1;
  credentialId: string;
  transports?: readonly PasskeyCredentialTransport[];
  /** base64url of the 32-byte salt actually evaluated, so it survives a change to the constant. */
  salt: string;
};

const b64url = {
  encode(bytes: Uint8Array): string {
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  decode(text: string): Uint8Array {
    const padded = text.replace(/-/g, "+").replace(/_/g, "/");
    return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  },
};

function readCredential(): StoredCredential | null {
  try {
    const raw = window.localStorage.getItem(CREDENTIAL_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredCredential;
    // Validated on the way OUT as well as in: a hand-edited value must read as
    // "no credential" rather than be forwarded into WebAuthn.
    if (parsed?.v !== 1 || typeof parsed.credentialId !== "string" || typeof parsed.salt !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** True when this browser already knows which passkey to ask for. */
export function hasMeraCredential(): boolean {
  return readCredential() !== null;
}

/**
 * Forget the pointer. Does NOT delete the passkey or the account — the same
 * credential re-derives the same address — it only stops this browser
 * pre-selecting it.
 */
export function forgetMeraCredential(): void {
  try {
    window.localStorage.removeItem(CREDENTIAL_KEY);
  } catch {
    // A browser refusing storage is not a reason to fail a sign-out.
  }
  // Forgetting WHICH passkey must also drop the resumable key, or the next load
  // silently resumes an account the user just asked this browser to forget.
  void walletFrame.disconnect().catch(() => {});
}

/**
 * The relying party this credential is scoped to.
 *
 * Read from the live host rather than configured, so localhost, a preview
 * deployment and production each stay in their own credential space
 * automatically.
 */
function rpId(): string {
  return window.location.hostname;
}

/**
 * Create the account. Prompts for a new passkey, so it needs a user gesture.
 *
 * Returns the PRF output — the private key — and NOTHING else has been done
 * with it. The caller's job is to hand it to the frame and zero it.
 *
 * `name` is what the authenticator shows when the user picks a passkey later,
 * so it wants to be something they recognise.
 */
export async function createPasskeyKey(user: { name: string; displayName?: string }): Promise<Uint8Array> {
  // Asked BEFORE the ceremony, because mera can only learn PRF is missing after
  // `navigator.credentials.create()` has already stored a credential — one this
  // app can never use, one more on every retry, and none of them removable from
  // script. Only an explicit negative refuses; see prfKnownUnavailable.
  if (await prfKnownUnavailable()) {
    throw new MeraError(
      "PRF_UNAVAILABLE",
      "This browser reports no WebAuthn PRF support, which is what derives the key.",
    );
  }

  const result = await createPasskeyWithPrfOutput({
    rp: { id: rpId(), name: walletConfig().brand },
    user: { name: user.name, displayName: user.displayName ?? user.name },
    prfSalt: PRF_SALT,
    // Adds `hints` so the browser ASKS where to save instead of diving into the
    // platform authenticator. Reaching the picker is what lets the user land on
    // an authenticator that implements PRF when the built-in one does not.
    webAuthnClient: hintedWebAuthnClient,
  });

  const stored: StoredCredential = {
    v: 1,
    credentialId: result.credentialId,
    transports: result.transports,
    salt: b64url.encode(result.prfSalt),
  };
  try {
    window.localStorage.setItem(CREDENTIAL_KEY, JSON.stringify(stored));
  } catch {
    // Storage refused (private window, quota). The account still works for this
    // session; the next visit simply has to ask which passkey to use.
  }

  return result.prfOutput;
}

/**
 * Unlock the existing account. Prompts the authenticator, so it needs a user
 * gesture too. Returns null when this browser has no stored pointer — the
 * caller should offer `createPasskeyKey` or a credential picker instead of
 * treating that as an error.
 */
export async function unlockPasskeyKey(): Promise<Uint8Array | null> {
  const stored = readCredential();
  if (!stored) return null;

  const result = await getPasskeyPrfOutput({
    rpId: rpId(),
    credential: { credentialId: stored.credentialId, transports: stored.transports },
    // The salt that was actually evaluated when the account was made, not the
    // current constant — see the header on why those can differ.
    prfSalt: b64url.decode(stored.salt),
    webAuthnClient: hintedWebAuthnClient,
  });

  return result.prfOutput;
}
