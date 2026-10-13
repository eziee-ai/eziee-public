import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type Db } from "./testing";
import { applyCredit, CreditLimitError, creditedSince, getAccount, ledgerSum, listLedger, placeHold, releaseStaleHolds, settleHold } from "./credits";
import { ensureUser } from "./auth";

const ALICE = "0x0000000000000000000000000000000000001001";
const USD = 1_000_000n;
let db: Db;

beforeEach(async () => {
  db = await createTestDb();
  await ensureUser(db, ALICE);
});

// A note on the "concurrent" tests here. They run on PGlite, which is ONE connection: concurrent transactions queue
// instead of interleaving. So these prove the arithmetic and the idempotency, which hold on any Postgres, and they
// do NOT prove that the `FOR UPDATE` row locks serialise writers, which only a multi-connection Postgres can show.
// The locks are there for that server; nothing in these tests would fail without them.
describe("listLedger", () => {
  it("lists an account's own rows, newest first, and never another account's", async () => {
    const BOB = "0x0000000000000000000000000000000000001002";
    await ensureUser(db, BOB);
    await applyCredit(db, { address: ALICE, amount: 5n * USD, kind: "topup_usdc", ref: "1:0xabc:0", test: true });
    await applyCredit(db, { address: BOB, amount: 9n * USD, kind: "adjustment", ref: "bob" });
    const hold = await placeHold(db, ALICE, USD);
    if (hold.ok) await settleHold(db, { holdId: hold.holdId, cost: 1_234n, ref: "usage:1" });
    const rows = await listLedger(db, ALICE);
    expect(rows.map((r) => [r.kind, r.deltaMicrousd, r.test])).toEqual([["usage", -1_234n, false], ["topup_usdc", 5n * USD, true]]);
  });
});

describe("applyCredit", () => {
  it("credits once per ref, however many times the same event is delivered", async () => {
    expect(await applyCredit(db, { address: ALICE, amount: 5n * USD, kind: "topup_card", ref: "evt_1" })).toBe(true);
    expect(await applyCredit(db, { address: ALICE, amount: 5n * USD, kind: "topup_card", ref: "evt_1" })).toBe(false);
    expect((await getAccount(db, ALICE)).balance).toBe(5n * USD);
    expect(await ledgerSum(db, ALICE)).toBe(5n * USD);
  });

  it("stays exact under concurrent replays of one ref", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => applyCredit(db, { address: ALICE, amount: USD, kind: "topup_usdc", ref: "5042002:0xabc:0" })));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await getAccount(db, ALICE)).balance).toBe(USD);
  });

  it("a refund may take the balance negative, and that blocks the account", async () => {
    await applyCredit(db, { address: ALICE, amount: USD, kind: "topup_card", ref: "evt_1" });
    await applyCredit(db, { address: ALICE, amount: -3n * USD, kind: "refund", ref: "re_1" });
    const account = await getAccount(db, ALICE);
    expect(account.balance).toBe(-2n * USD);
    expect(account.blocked).toBe(true);
    expect(account.spendable).toBe(0n);
  });

  it("refuses a zero amount and an unknown kind", async () => {
    await expect(applyCredit(db, { address: ALICE, amount: 0n, kind: "topup_card", ref: "z" })).rejects.toThrow();
    await expect(applyCredit(db, { address: ALICE, amount: 1n, kind: "gift" as never, ref: "g" })).rejects.toThrow();
  });
});

describe("placeHold / settleHold", () => {
  beforeEach(async () => {
    await applyCredit(db, { address: ALICE, amount: USD, kind: "topup_card", ref: "seed" });
  });

  it("refuses a hold larger than spendable credit, and says how much there is", async () => {
    expect(await placeHold(db, ALICE, 2n * USD)).toEqual({ ok: false, reason: "insufficient", spendable: USD });
  });

  it("counts open holds against spendable credit", async () => {
    const first = await placeHold(db, ALICE, 600_000n);
    expect(first.ok).toBe(true);
    expect(await placeHold(db, ALICE, 600_000n)).toMatchObject({ ok: false, spendable: 400_000n });
    expect((await getAccount(db, ALICE)).spendable).toBe(400_000n);
  });

  it("settling charges the real cost, releases the hold, and writes one usage row", async () => {
    const hold = await placeHold(db, ALICE, 100_000n);
    if (!hold.ok) throw new Error("hold refused");
    expect(await settleHold(db, { holdId: hold.holdId, cost: 4_200n, ref: "req_1", meta: { model: "moonshotai/kimi-k3" } })).toEqual({ charged: 4_200n });
    const account = await getAccount(db, ALICE);
    expect(account).toMatchObject({ balance: USD - 4_200n, held: 0n, spendable: USD - 4_200n });
    expect(await ledgerSum(db, ALICE)).toBe(account.balance);
  });

  it("settling twice charges once", async () => {
    const hold = await placeHold(db, ALICE, 100_000n);
    if (!hold.ok) throw new Error("hold refused");
    await settleHold(db, { holdId: hold.holdId, cost: 4_200n, ref: "req_1" });
    expect(await settleHold(db, { holdId: hold.holdId, cost: 4_200n, ref: "req_1" })).toEqual({ charged: 0n });
    expect((await getAccount(db, ALICE)).balance).toBe(USD - 4_200n);
  });

  it("never charges more than the hold, so usage alone cannot take a balance negative", async () => {
    const hold = await placeHold(db, ALICE, 10_000n);
    if (!hold.ok) throw new Error("hold refused");
    expect(await settleHold(db, { holdId: hold.holdId, cost: 99_999n, ref: "req_2" })).toEqual({ charged: 10_000n });
  });

  it("a zero-cost settle (the model never ran) releases the hold and writes nothing", async () => {
    const hold = await placeHold(db, ALICE, 10_000n);
    if (!hold.ok) throw new Error("hold refused");
    await settleHold(db, { holdId: hold.holdId, cost: 0n, ref: "req_3" });
    expect(await getAccount(db, ALICE)).toMatchObject({ balance: USD, held: 0n });
  });

  it("concurrent holds can never add up past the balance", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => placeHold(db, ALICE, 300_000n)));
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect((await getAccount(db, ALICE)).held).toBe(900_000n);
  });

  it("refuses a blocked account", async () => {
    await applyCredit(db, { address: ALICE, amount: -5n * USD, kind: "refund", ref: "re_1" });
    expect(await placeHold(db, ALICE, 1n)).toMatchObject({ ok: false, reason: "blocked" });
  });

  it("releases holds a crashed request left open", async () => {
    const hold = await placeHold(db, ALICE, 500_000n);
    expect(hold.ok).toBe(true);
    expect(await releaseStaleHolds(db, new Date(Date.now() + 3_600_000))).toBe(1);
    expect(await getAccount(db, ALICE)).toMatchObject({ balance: USD, held: 0n });
  });

  it("scoped to one account, leaves everyone else's holds alone, and leaves young holds alone", async () => {
    const BOB = "0x0000000000000000000000000000000000001002";
    await ensureUser(db, BOB);
    await applyCredit(db, { address: ALICE, amount: USD, kind: "adjustment", ref: "a" });
    await applyCredit(db, { address: BOB, amount: USD, kind: "adjustment", ref: "b" });
    await placeHold(db, ALICE, 500_000n);
    await placeHold(db, BOB, 500_000n);
    expect(await releaseStaleHolds(db, new Date(Date.now() - 3_600_000), ALICE)).toBe(0);
    expect(await releaseStaleHolds(db, new Date(Date.now() + 3_600_000), ALICE)).toBe(1);
    expect((await getAccount(db, ALICE)).held).toBe(0n);
    expect((await getAccount(db, BOB)).held).toBe(500_000n);
  });
});

describe("creditedSince", () => {
  it("adds up one kind of credit for one account since a moment, and nothing else", async () => {
    const db = await createTestDb();
    const alice = "0x0000000000000000000000000000000000001001";
    await ensureUser(db, alice);
    await applyCredit(db, { address: alice, amount: 2_000_000n, kind: "topup_token", ref: "t1" });
    await applyCredit(db, { address: alice, amount: 3_000_000n, kind: "topup_usdc", ref: "u1" });
    expect(await creditedSince(db, { address: alice, kind: "topup_token", since: new Date(Date.now() - 60_000) })).toBe(2_000_000n);
    expect(await creditedSince(db, { address: alice, kind: "topup_token", since: new Date(Date.now() + 60_000) })).toBe(0n);
  });
});

describe("applyCredit with a limit", () => {
  it("credits up to the limit and refuses what would pass it, even when asked at the same moment", async () => {
    const db = await createTestDb();
    const alice = "0x0000000000000000000000000000000000001001";
    await ensureUser(db, alice);
    const limit = { since: new Date(Date.now() - 60_000), maxMicrousd: 10_000_000n };
    const results = await Promise.allSettled([1, 2, 3].map((n) => applyCredit(db, { address: alice, amount: 4_000_000n, kind: "topup_token", ref: `t${n}`, limit })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(CreditLimitError);
    expect((refused.reason as CreditLimitError).leftMicrousd).toBe(2_000_000n);
    expect((await getAccount(db, alice)).balance).toBe(8_000_000n);
  });

  it("is a no-op, not a refusal, for a ref already credited", async () => {
    const db = await createTestDb();
    const alice = "0x0000000000000000000000000000000000001001";
    await ensureUser(db, alice);
    const limit = { since: new Date(Date.now() - 60_000), maxMicrousd: 5_000_000n };
    expect(await applyCredit(db, { address: alice, amount: 5_000_000n, kind: "topup_token", ref: "t1", limit })).toBe(true);
    expect(await applyCredit(db, { address: alice, amount: 5_000_000n, kind: "topup_token", ref: "t1", limit })).toBe(false);
  });
});
