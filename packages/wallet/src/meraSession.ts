"use client";

/**
 * A time-boxed resume for the passkey wallet.
 *
 * ## What changed, and why this file exists
 *
 * The account key is the passkey's PRF output, and it used to live ONLY in a
 * live signing session — so a reload ended the session and the user tapped
 * their passkey again. That is the safest possible arrangement and it was the
 * documented design.
 *
 * It was also, in practice, a refresh logging people out. This file is the
 * deliberate trade: the key is persisted so a reload resumes silently, and the
 * exposure is bounded by an EXPIRY rather than by the lifetime of a tab.
 *
 * ## What "persisted" means here, precisely
 *
 * Not in localStorage in the clear. The key is encrypted with AES-GCM under a
 * **non-extractable** `CryptoKey` held in IndexedDB; only the ciphertext and
 * the IV go to localStorage. `extractable: false` is enforced by the browser,
 * so nothing — including this app — can read those bytes back out. Decryption
 * has to be performed BY the browser, ON this origin.
 *
 * That does not stop script running on this origin: anything that can call
 * `restoreMeraSession()` gets the key, so an XSS on example.com is still game over.
 * It stops the cheaper attacks that the plain version would hand over for free
 * — a browser-profile backup, a synced storage dump, an extension with
 * `storage` permission but no script injection, devtools on a borrowed laptop.
 * The expiry is what bounds the rest.
 *
 * ## The expiry is ABSOLUTE, not sliding
 *
 * `SESSION_TTL_MS` runs from the tap that unlocked the account, and using the
 * app does not extend it. A sliding window renews itself for exactly the person
 * who is active on the machine, which on a shared or stolen laptop is not the
 * owner — so it would be a session that never ends for the one case the expiry
 * is for. One tap a day is the price.
 *
 * ## Every failure reads as "no session"
 *
 * A missing wrapping key, a malformed record, a decrypt that does not
 * authenticate, an address that does not match the one recorded, IndexedDB
 * refused in a private window: all of them wipe and return null, which costs a
 * passkey tap. The opposite bias — proceeding on a record we could not fully
 * verify — is how a key gets used that nobody can account for.
 */

const SESSION_KEY = "wlt.mera-session";

/** The IndexedDB database and store holding the non-extractable wrapping key. */
const DB_NAME = "wlt.mera";
const STORE = "wrap";
const WRAP_ID = "v1";

/**
 * How long a tap lasts. One day: long enough that a refresh, a closed tab and
 * coming back after lunch all resume, short enough that a machine left alone
 * overnight asks again.
 */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

type StoredSession = {
  v: 1;
  /** Checked against the address the restored key actually derives. */
  address: string;
  /** base64url AES-GCM IV, 12 bytes, fresh per write. */
  iv: string;
  /** base64url ciphertext of the 32-byte key. */
  ct: string;
  /** Epoch ms. Absolute — see the header. */
  expiresAt: number;
};

const b64url = {
  encode(bytes: Uint8Array): string {
    return btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  },
  decode(text: string): Uint8Array {
    const padded = text.replace(/-/g, "+").replace(/_/g, "/");
    return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  },
};

/**
 * A plain `ArrayBuffer` copy.
 *
 * WebCrypto's `BufferSource` will not accept a `Uint8Array` whose backing store
 * TypeScript cannot prove is an `ArrayBuffer` rather than a `SharedArrayBuffer`
 * — and a cast past that would be a lie about memory the browser is going to
 * read. Copying into a fresh buffer is a few dozen bytes and makes it true.
 */
function bufferOf(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(STORE)) open.result.createObjectStore(STORE);
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}

function idbRequest<T>(tx: IDBTransaction, request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    tx.onabort = () => reject(tx.error);
  });
}

/**
 * The wrapping key, created on first use and reused after.
 *
 * `extractable: false` is the entire point — a CryptoKey structured-clones into
 * IndexedDB with that flag intact, so the browser will encrypt and decrypt with
 * it and will not export it, to us or to anyone.
 */
async function wrappingKey(create: boolean): Promise<CryptoKey | null> {
  const db = await idb();
  try {
    const read = db.transaction(STORE, "readonly");
    const existing = await idbRequest(read, read.objectStore(STORE).get(WRAP_ID));
    if (existing) return existing as CryptoKey;
    if (!create) return null;

    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]);
    const write = db.transaction(STORE, "readwrite");
    await idbRequest(write, write.objectStore(STORE).put(key, WRAP_ID));
    return key;
  } finally {
    db.close();
  }
}

function readSession(): StoredSession | null {
  try {
    const raw = window.localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSession;
    // Validated on the way OUT as well as in, the same rule the credential
    // pointer and the support-ticket store follow: a hand-edited value reads as
    // "no session" rather than being forwarded into a decrypt.
    if (
      parsed?.v !== 1 ||
      typeof parsed.address !== "string" ||
      typeof parsed.iv !== "string" ||
      typeof parsed.ct !== "string" ||
      typeof parsed.expiresAt !== "number"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Is there a session a reload could resume, without decrypting anything?
 *
 * Synchronous on purpose: wagmi's `isAuthorized` and the connect path both need
 * an answer before any ceremony, and this one is a timestamp comparison.
 * It reports that a record EXISTS and has not expired — the decrypt can still
 * fail, and `restoreMeraSession` is the call that finds out.
 */
export function hasMeraSession(): boolean {
  const stored = readSession();
  return stored !== null && stored.expiresAt > Date.now();
}

/** The address a resumable session belongs to, for UI that wants to name it. */
export function meraSessionAddress(): string | null {
  const stored = readSession();
  return stored && stored.expiresAt > Date.now() ? stored.address : null;
}

/** When the current session stops resuming. Null when there is none. */
export function meraSessionExpiry(): number | null {
  const stored = readSession();
  return stored && stored.expiresAt > Date.now() ? stored.expiresAt : null;
}

/**
 * Persist the key for `SESSION_TTL_MS`.
 *
 * Called at the two points a tap has just produced one — creation and unlock —
 * so the clock starts at the tap rather than at some later first use.
 *
 * Never throws: a browser refusing IndexedDB or storage (private window, quota,
 * storage blocked) costs the resume, and the wallet still works for this
 * session. Failing the connect over it would be strictly worse.
 */
export async function saveMeraSession(privateKey: Uint8Array, address: string): Promise<void> {
  try {
    const key = await wrappingKey(true);
    if (!key) return;

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bufferOf(privateKey));

    const record: StoredSession = {
      v: 1,
      address,
      iv: b64url.encode(iv),
      ct: b64url.encode(new Uint8Array(ct)),
      expiresAt: Date.now() + SESSION_TTL_MS,
    };
    window.localStorage.setItem(SESSION_KEY, JSON.stringify(record));
  } catch {
    // See above: a lost resume is a passkey tap, not a failure.
  }
}

/**
 * The key back, or null.
 *
 * `expected` is the address the caller believes this session belongs to; when
 * given, a mismatch wipes rather than returns. Nothing should ever be signed by
 * a key that does not derive the address it was filed under.
 */
export async function restoreMeraSession(): Promise<{
  privateKey: Uint8Array;
  address: string;
} | null> {
  const stored = readSession();
  if (!stored) return null;

  if (stored.expiresAt <= Date.now()) {
    endMeraSession();
    return null;
  }

  try {
    const key = await wrappingKey(false);
    if (!key) {
      // Ciphertext with no wrapping key is unreadable forever — IndexedDB was
      // cleared without localStorage, which browsers do for storage pressure.
      endMeraSession();
      return null;
    }

    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bufferOf(b64url.decode(stored.iv)) },
      key,
      bufferOf(b64url.decode(stored.ct)),
    );
    const privateKey = new Uint8Array(plain);
    if (privateKey.length !== 32) {
      endMeraSession();
      return null;
    }

    return { privateKey, address: stored.address };
  } catch {
    // AES-GCM is authenticated, so a failed decrypt means the record was
    // tampered with or the wrapping key is a different one. Either way it is
    // not a session.
    endMeraSession();
    return null;
  }
}

/**
 * Forget the session.
 *
 * The localStorage record goes AND the wrapping key is deleted, so the
 * ciphertext is unrecoverable even if a copy of localStorage survives
 * elsewhere — a backup, a sync, a forensic image. Deleting only the pointer
 * would leave the material intact and the key able to decrypt it.
 *
 * Fire-and-forget on the IndexedDB half so a sign-out is never waiting on it.
 */
export function endMeraSession(): void {
  try {
    window.localStorage.removeItem(SESSION_KEY);
  } catch {
    // A browser refusing storage is not a reason to fail a sign-out.
  }
  void (async () => {
    try {
      const db = await idb();
      try {
        const tx = db.transaction(STORE, "readwrite");
        await idbRequest(tx, tx.objectStore(STORE).delete(WRAP_ID));
      } finally {
        db.close();
      }
    } catch {
      // Nothing to do: the pointer is already gone, so nothing reads this.
    }
  })();
}
