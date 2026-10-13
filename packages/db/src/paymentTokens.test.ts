import { describe, expect, it } from "vitest";
import { getPaymentToken, listPaymentTokens, savePaymentToken } from "./paymentTokens";
import { createTestDb } from "./testing";

const EZT = { chainId: 5042002, address: "0x1111111111111111111111111111111111111111", symbol: "EZT", decimals: 18, microusdPerToken: 10_000n, enabled: true, faucet: true, updatedBy: "0xF8FB4672170607C95663f4Cc674dDb1386b7CfE0" };

describe("payment tokens", () => {
  it("are saved, read back, and updated in place", async () => {
    const db = await createTestDb();
    await savePaymentToken(db, EZT);
    expect(await getPaymentToken(db, EZT.chainId, EZT.address)).toMatchObject({ symbol: "EZT", microusdPerToken: 10_000n, faucet: true });
    await savePaymentToken(db, { ...EZT, microusdPerToken: 20_000n });
    expect(await listPaymentTokens(db)).toHaveLength(1);
    expect((await getPaymentToken(db, EZT.chainId, EZT.address))?.microusdPerToken).toBe(20_000n);
  });

  it("a disabled token is listed for the operator and cannot be paid with", async () => {
    const db = await createTestDb();
    await savePaymentToken(db, { ...EZT, enabled: false });
    expect(await getPaymentToken(db, EZT.chainId, EZT.address)).toBeNull();
    expect(await listPaymentTokens(db, { enabledOnly: true })).toEqual([]);
    expect(await listPaymentTokens(db)).toHaveLength(1);
  });

  it("refuses a price of zero", async () => {
    const db = await createTestDb();
    await expect(savePaymentToken(db, { ...EZT, microusdPerToken: 0n })).rejects.toThrow();
  });
});
