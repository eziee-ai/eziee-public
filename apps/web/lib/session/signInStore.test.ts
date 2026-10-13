import { describe, expect, it, vi } from "vitest";
import { createSignInStore, MAX_ATTEMPTS } from "./signInStore";

const ALICE = "0x0000000000000000000000000000000000001001";

describe("sign-in store — one sign-in per wallet, however many components ask", () => {
  it("runs once when several callers ask in the same moment", async () => {
    const store = createSignInStore();
    const run = vi.fn(async () => {});
    await Promise.all([store.ensure(ALICE, run, 0), store.ensure(ALICE, run, 0), store.ensure(ALICE.toUpperCase().replace("0X", "0x"), run, 0)]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(store.state(ALICE)).toEqual({ signingIn: false, error: null });
  });

  it("reports signing in while it runs", async () => {
    const store = createSignInStore();
    let finish!: () => void;
    const pending = store.ensure(ALICE, () => new Promise<void>((resolve) => (finish = resolve)), 0);
    expect(store.state(ALICE).signingIn).toBe(true);
    finish();
    await pending;
    expect(store.state(ALICE).signingIn).toBe(false);
  });

  it("after a failure does not try again by itself, says why, and tries again when the person asks", async () => {
    const store = createSignInStore();
    const run = vi.fn(async () => Promise.reject(new Error("Sign-in could not start. Try again.")));
    await store.ensure(ALICE, run, 0);
    await store.ensure(ALICE, run, 1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(store.state(ALICE).error).toBe("Sign-in could not start. Try again.");

    const works = vi.fn(async () => {});
    await store.retry(ALICE, works, 2);
    expect(works).toHaveBeenCalledTimes(1);
    expect(store.state(ALICE).error).toBeNull();
  });

  it("signs in again when asked later (the server session expired), but never in a tight loop", async () => {
    const store = createSignInStore();
    const run = vi.fn(async () => {});
    for (let i = 0; i < MAX_ATTEMPTS + 3; i++) await store.ensure(ALICE, run, i * 1000);
    expect(run).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(store.state(ALICE).error).toMatch(/did not stay signed in/);
    // A long while later it may try again.
    await store.ensure(ALICE, run, 60 * 60_000);
    expect(run).toHaveBeenCalledTimes(MAX_ATTEMPTS + 1);
  });

  it("tells subscribers when anything changes", async () => {
    const store = createSignInStore();
    const heard = vi.fn();
    store.subscribe(heard);
    await store.ensure(ALICE, async () => {}, 0);
    expect(heard.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
