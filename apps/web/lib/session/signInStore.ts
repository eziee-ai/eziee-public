/**
 * One sign-in per wallet, shared by every component that needs the session.
 *
 * `useAppSession` is used by the chat view and by each sidebar. Left to themselves they would each notice
 * "connected, not signed in" in the same render and each sign in: two nonces, two signatures, two sessions.
 * This store is outside React, so whoever asks first does the work and everyone else waits on the same promise.
 *
 * It signs in again when asked again later, because a server session expires while a tab stays open. What it
 * will not do is loop: a sign-in that "succeeds" but does not stick (a cookie the browser refuses, say) would
 * otherwise repeat forever, so attempts are counted over a window and then it stops and says so.
 */

export const MAX_ATTEMPTS = 3;
const ATTEMPT_WINDOW_MS = 5 * 60_000;
const DID_NOT_STICK = "This browser did not stay signed in. Check that cookies are allowed for this site, then try again.";

interface Entry {
  inFlight: Promise<void> | null;
  error: string | null;
  attempts: number[];
}

export function createSignInStore() {
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  const IDLE = Object.freeze({ signingIn: false, error: null as string | null });
  const snapshots = new Map<string, { signingIn: boolean; error: string | null }>();

  const entry = (address: string): Entry => {
    const key = address.toLowerCase();
    let found = entries.get(key);
    if (!found) entries.set(key, (found = { inFlight: null, error: null, attempts: [] }));
    return found;
  };
  const publish = (address: string) => {
    const e = entry(address);
    snapshots.set(address.toLowerCase(), { signingIn: e.inFlight !== null, error: e.error });
    for (const listener of listeners) listener();
  };

  function start(address: string, run: () => Promise<void>, now: number): Promise<void> {
    const e = entry(address);
    e.attempts = e.attempts.filter((at) => now - at < ATTEMPT_WINDOW_MS);
    if (e.attempts.length >= MAX_ATTEMPTS) {
      e.error = DID_NOT_STICK;
      publish(address);
      return Promise.resolve();
    }
    e.attempts.push(now);
    e.error = null;
    e.inFlight = run()
      .catch((error: unknown) => {
        e.error = error instanceof Error ? error.message : "Sign-in failed. Try again.";
      })
      .finally(() => {
        e.inFlight = null;
        publish(address);
      });
    publish(address);
    return e.inFlight;
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** A stable object per change, as `useSyncExternalStore` requires. */
    state(address: string | undefined): { signingIn: boolean; error: string | null } {
      return (address && snapshots.get(address.toLowerCase())) || IDLE;
    },
    /** Sign in unless that is already happening, or already failed (then only `retry` tries again). */
    ensure(address: string, run: () => Promise<void>, now: number = Date.now()): Promise<void> {
      const e = entry(address);
      if (e.inFlight) return e.inFlight;
      // A real failure waits for the person. "Did not stick" is only a pause: once the window has passed, it may try again.
      const pauseOver = e.error === DID_NOT_STICK && e.attempts.every((at) => now - at >= ATTEMPT_WINDOW_MS);
      if (e.error && !pauseOver) return Promise.resolve();
      return start(address, run, now);
    },
    /** The person asked to try again. */
    retry(address: string, run: () => Promise<void>, now: number = Date.now()): Promise<void> {
      const e = entry(address);
      if (e.inFlight) return e.inFlight;
      e.attempts = [];
      return start(address, run, now);
    },
  };
}

export const signInStore = createSignInStore();
