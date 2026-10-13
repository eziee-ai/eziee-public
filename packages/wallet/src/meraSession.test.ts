// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasMeraSession, meraSessionAddress, meraSessionExpiry, SESSION_TTL_MS } from "./meraSession";

/**
 * The expiry, and nothing else.
 *
 * `saveMeraSession` / `restoreMeraSession` need IndexedDB and WebCrypto, and the
 * ceremony that feeds them needs a real authenticator — none of which exists
 * here, which is the same limit `webauthnClient.test.ts` records. What CAN be
 * pinned without a browser is the decision every one of those paths is gated on:
 * whether a stored record still counts.
 *
 * That is worth pinning precisely because it is arithmetic that fails silently.
 * A session which never expires looks exactly like one that works.
 */

const KEY = "wlt.mera-session";
const ADDRESS = "0x7a3f000000000000000000000000000000009c21";

function store(overrides: Record<string, unknown> = {}): void {
  window.localStorage.setItem(
    KEY,
    JSON.stringify({
      v: 1,
      address: ADDRESS,
      iv: "AAAAAAAAAAAAAAAA",
      ct: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      expiresAt: Date.now() + SESSION_TTL_MS,
      ...overrides,
    }),
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("hasMeraSession", () => {
  it("is false when nothing is stored", () => {
    expect(hasMeraSession()).toBe(false);
  });

  it("is true for a fresh session", () => {
    store();
    expect(hasMeraSession()).toBe(true);
  });

  it("is false once the expiry passes", () => {
    store({ expiresAt: Date.now() - 1 });
    expect(hasMeraSession()).toBe(false);
  });

  it("stops resuming exactly one TTL after the tap, never later", () => {
    // The failure this guards is a session that quietly outlives its window —
    // which looks identical to one working correctly, forever.
    vi.useFakeTimers();
    const tap = new Date("2026-09-13T09:00:00Z");
    vi.setSystemTime(tap);
    store({ expiresAt: tap.getTime() + SESSION_TTL_MS });

    vi.setSystemTime(tap.getTime() + SESSION_TTL_MS - 1000);
    expect(hasMeraSession()).toBe(true);

    vi.setSystemTime(tap.getTime() + SESSION_TTL_MS + 1000);
    expect(hasMeraSession()).toBe(false);
  });

  it("does not slide forward when the app is used", () => {
    // An absolute window is the decision recorded in the module header: a
    // sliding one renews for whoever is at the machine, which on a stolen
    // laptop is not the owner.
    vi.useFakeTimers();
    const tap = Date.now();
    store({ expiresAt: tap + SESSION_TTL_MS });

    for (const t of [1, 2, 3, 4, 5]) {
      vi.setSystemTime(tap + t * 60 * 60 * 1000);
      expect(hasMeraSession()).toBe(true);
      expect(meraSessionExpiry()).toBe(tap + SESSION_TTL_MS);
    }

    vi.setSystemTime(tap + SESSION_TTL_MS + 1);
    expect(hasMeraSession()).toBe(false);
  });
});

describe("record validation", () => {
  it("reads a hand-edited record as no session, never forwarding it to a decrypt", () => {
    for (const bad of [
      { v: 2 },
      { address: 1234 },
      { iv: null },
      { ct: undefined },
      { expiresAt: "tomorrow" },
    ]) {
      store(bad);
      expect(hasMeraSession()).toBe(false);
    }
  });

  it("reads unparseable storage as no session rather than throwing", () => {
    window.localStorage.setItem(KEY, "{not json");
    expect(hasMeraSession()).toBe(false);
    expect(meraSessionAddress()).toBeNull();
  });
});

describe("meraSessionAddress", () => {
  it("names the account a reload would resume", () => {
    store();
    expect(meraSessionAddress()).toBe(ADDRESS);
  });

  it("names nothing once expired — an expired session belongs to nobody", () => {
    store({ expiresAt: Date.now() - 1 });
    expect(meraSessionAddress()).toBeNull();
  });
});
