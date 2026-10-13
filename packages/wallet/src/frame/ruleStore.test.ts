// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { addRule, clearSessionRules, listRules, purgeExpired, reserveSpend, resetRuleStoreForTests, revokeRule, spentOn } from "./ruleStore";
import type { Rule } from "./rules";

const ALICE = "0x0000000000000000000000000000000000001001";
const USDC = "0x0000000000000000000000000000000000000201";
const NOW = Date.UTC(2026, 8, 20, 12);

function rule(patch: Partial<Rule> = {}): Rule {
  return { id: "00000000-0000-4000-8000-000000000003", account: ALICE, protocol: "rate", action: "swap", chainId: 5042002, token: USDC, maxPerTx: 50_000_000n, maxPerDay: 120_000_000n, expiresAt: NOW + 86_400_000, persistent: false, sessionKey: NOW + 86_400_000, createdAt: NOW, ...patch };
}

beforeEach(async () => {
  await resetRuleStoreForTests();
});

describe("rules", () => {
  it("round-trips a rule with its bigint caps intact", async () => {
    await addRule(rule({ maxPerDay: 2n ** 200n }));
    expect(await listRules()).toEqual([rule({ maxPerDay: 2n ** 200n })]);
  });

  it("reads a rule made for Iter, before it became Rate, as Rate's", async () => {
    await addRule(rule({ protocol: "iter" }));
    expect((await listRules()).map((r) => r.protocol)).toEqual(["rate"]);
  });

  it("revokes one rule and its counters, leaving the others", async () => {
    await addRule(rule());
    await addRule(rule({ id: "00000000-0000-4000-8000-000000000004" }));
    await reserveSpend("00000000-0000-4000-8000-000000000003", "2026-09-20", 10n, 120_000_000n);
    await revokeRule("00000000-0000-4000-8000-000000000003");
    expect((await listRules()).map((r) => r.id)).toEqual(["00000000-0000-4000-8000-000000000004"]);
    expect(await spentOn("00000000-0000-4000-8000-000000000003", "2026-09-20")).toBe(0n);
  });

  it("ends the session by deleting every rule that is not persistent", async () => {
    await addRule(rule());
    await addRule(rule({ id: "00000000-0000-4000-8000-000000000001", persistent: true }));
    await clearSessionRules();
    expect((await listRules()).map((r) => r.id)).toEqual(["00000000-0000-4000-8000-000000000001"]);
  });

  it("purges expired rules", async () => {
    await addRule(rule({ expiresAt: NOW - 1 }));
    await addRule(rule({ id: "00000000-0000-4000-8000-000000000002" }));
    await purgeExpired(NOW);
    expect((await listRules()).map((r) => r.id)).toEqual(["00000000-0000-4000-8000-000000000002"]);
  });

  it("refuses to overwrite an existing rule id", async () => {
    await addRule(rule());
    await expect(addRule(rule({ maxPerTx: 999n }))).rejects.toThrow();
    expect((await listRules())[0]!.maxPerTx).toBe(50_000_000n);
  });
});

describe("reserveSpend", () => {
  it("counts up to the daily cap and refuses the spend that would cross it", async () => {
    expect(await reserveSpend("00000000-0000-4000-8000-000000000003", "2026-09-20", 50_000_000n, 120_000_000n)).toBe(true);
    expect(await reserveSpend("00000000-0000-4000-8000-000000000003", "2026-09-20", 50_000_000n, 120_000_000n)).toBe(true);
    expect(await reserveSpend("00000000-0000-4000-8000-000000000003", "2026-09-20", 20_000_001n, 120_000_000n)).toBe(false);
    expect(await reserveSpend("00000000-0000-4000-8000-000000000003", "2026-09-20", 20_000_000n, 120_000_000n)).toBe(true);
    expect(await spentOn("00000000-0000-4000-8000-000000000003", "2026-09-20")).toBe(120_000_000n);
  });

  it("keeps a refused reservation out of the counter", async () => {
    await reserveSpend("00000000-0000-4000-8000-000000000003", "2026-09-20", 100n, 100n);
    await reserveSpend("00000000-0000-4000-8000-000000000003", "2026-09-20", 1n, 100n);
    expect(await spentOn("00000000-0000-4000-8000-000000000003", "2026-09-20")).toBe(100n);
  });

  it("is atomic: concurrent reservations can never add up past the cap", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => reserveSpend("00000000-0000-4000-8000-000000000003", "2026-09-20", 30n, 100n)));
    expect(results.filter(Boolean)).toHaveLength(3);
    expect(await spentOn("00000000-0000-4000-8000-000000000003", "2026-09-20")).toBe(90n);
  });

  it("counts each day and each rule separately", async () => {
    await reserveSpend("00000000-0000-4000-8000-000000000003", "2026-09-20", 100n, 100n);
    expect(await reserveSpend("00000000-0000-4000-8000-000000000003", "2026-09-21", 100n, 100n)).toBe(true);
    expect(await reserveSpend("00000000-0000-4000-8000-000000000004", "2026-09-20", 100n, 100n)).toBe(true);
  });

  it("refuses a non-positive amount rather than treating it as free", async () => {
    expect(await reserveSpend("00000000-0000-4000-8000-000000000003", "2026-09-20", 0n, 100n)).toBe(false);
    expect(await reserveSpend("00000000-0000-4000-8000-000000000003", "2026-09-20", -5n, 100n)).toBe(false);
  });
});
