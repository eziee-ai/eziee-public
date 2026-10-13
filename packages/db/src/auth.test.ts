import { beforeEach, describe, expect, it } from "vitest";
import { consumeNonce, createSession, deleteSession, ensureUser, getSession, issueNonce } from "./auth";
import { createTestDb, type Db } from "./testing";

const ALICE = "0x0000000000000000000000000000000000001001";
let db: Db;
const NOW = new Date("2026-09-20T12:00:00Z");

beforeEach(async () => {
  db = await createTestDb();
});

describe("sign-in nonces", () => {
  it("are single use", async () => {
    const nonce = await issueNonce(db, { binding: "browser-a", now: NOW });
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{32,64}$/);
    expect(await consumeNonce(db, { nonce, binding: "browser-a", now: NOW })).toBe(true);
    expect(await consumeNonce(db, { nonce, binding: "browser-a", now: NOW })).toBe(false);
  });

  it("are only good in the browser that asked for them", async () => {
    const nonce = await issueNonce(db, { binding: "browser-a", now: NOW });
    expect(await consumeNonce(db, { nonce, binding: "browser-b", now: NOW })).toBe(false);
    // A failed attempt from elsewhere must not burn it for its owner.
    expect(await consumeNonce(db, { nonce, binding: "browser-a", now: NOW })).toBe(true);
  });

  it("expire after five minutes", async () => {
    const nonce = await issueNonce(db, { binding: "b", now: NOW });
    expect(await consumeNonce(db, { nonce, binding: "b", now: new Date(NOW.getTime() + 5 * 60_000 + 1) })).toBe(false);
  });

  it("cannot be raced: many concurrent uses, one winner", async () => {
    const nonce = await issueNonce(db, { binding: "b", now: NOW });
    const results = await Promise.all(Array.from({ length: 8 }, () => consumeNonce(db, { nonce, binding: "b", now: NOW })));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("an unknown nonce is refused", async () => {
    expect(await consumeNonce(db, { nonce: "never-issued", binding: "b", now: NOW })).toBe(false);
  });
});

describe("sessions", () => {
  it("round-trips a token to its address until it expires, storing only a hash", async () => {
    await ensureUser(db, ALICE);
    const { token, expiresAt } = await createSession(db, { address: ALICE, now: NOW });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(expiresAt.getTime() - NOW.getTime()).toBe(24 * 3_600_000);
    expect(await getSession(db, { token, now: NOW })).toEqual({ address: ALICE, expiresAt });
    expect(await getSession(db, { token, now: new Date(expiresAt.getTime() + 1) })).toBeNull();
    expect(await getSession(db, { token: "forged", now: NOW })).toBeNull();
  });

  it("logging out kills the token", async () => {
    await ensureUser(db, ALICE);
    const { token } = await createSession(db, { address: ALICE, now: NOW });
    await deleteSession(db, token);
    expect(await getSession(db, { token, now: NOW })).toBeNull();
  });
});
