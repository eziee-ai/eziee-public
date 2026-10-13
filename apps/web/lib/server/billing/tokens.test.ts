import { describe, expect, it } from "vitest";
import { createTestDb } from "@repo/db/testing";
import { applyCredit, ensureUser, savePaymentToken } from "@repo/db";
import { parseUsdPrice, paymentTokenRefusal, tokenChainAllowed, tokenCreditLeftToday, tokenRail } from "./tokens";

const TREASURY = "0x0000000000000000000000000000000000007001";
const ARC = 5042002;

describe("parseUsdPrice", () => {
  it.each([
    ["1", 1_000_000n],
    ["0.01", 10_000n],
    ["0.000001", 1n],
    [" 2.5 ", 2_500_000n],
  ])("reads %s dollars", (input, micro) => expect(parseUsdPrice(input)).toBe(micro));

  it.each(["0", "0.0000001", "-1", "1e3", "", "abc", "1,000"])("refuses %s", (input) => expect(parseUsdPrice(input)).toBeNull());
});

describe("tokenRail", () => {
  const ezt = { chainId: ARC, address: "0x1111111111111111111111111111111111111111", symbol: "EZT", decimals: 18, microusdPerToken: 10_000n, enabled: true, faucet: true, updatedBy: TREASURY };

  it("is off without a treasury", async () => {
    expect(await tokenRail(await createTestDb(), {})).toBeNull();
  });

  it("offers a testnet token only when testnet credit is switched on, and never a disabled one", async () => {
    const db = await createTestDb();
    await savePaymentToken(db, ezt);
    await savePaymentToken(db, { ...ezt, address: "0x2222222222222222222222222222222222222222", enabled: false });
    expect((await tokenRail(db, { BILLING_TREASURY_ADDRESS: TREASURY }))?.tokens).toEqual([]);
    const rail = await tokenRail(db, { BILLING_TREASURY_ADDRESS: TREASURY, BILLING_ALLOW_TESTNET_CREDIT: "1" });
    expect(rail?.tokens.map((token) => token.symbol)).toEqual(["EZT"]);
    expect(tokenChainAllowed(1, {})).toBe(false);
  });
});

describe("tokenCreditLeftToday", () => {
  it("counts only token credit from the last 24 hours against the daily cap", async () => {
    const db = await createTestDb();
    const alice = "0x0000000000000000000000000000000000001001";
    await ensureUser(db, alice);
    expect(await tokenCreditLeftToday(db, alice, new Date(), {})).toBe(10_000_000n);
    await applyCredit(db, { address: alice, amount: 4_000_000n, kind: "topup_token", ref: "t1" });
    await applyCredit(db, { address: alice, amount: 50_000_000n, kind: "topup_usdc", ref: "u1" });
    expect(await tokenCreditLeftToday(db, alice, new Date(), {})).toBe(6_000_000n);
    expect(await tokenCreditLeftToday(db, alice, new Date(Date.now() + 25 * 3_600_000), {})).toBe(10_000_000n);
    expect(await tokenCreditLeftToday(db, alice, new Date(), { BILLING_TOKEN_MAX_PER_DAY_MICROUSD: "1000000" })).toBe(0n);
  });
});

describe("paymentTokenRefusal", () => {
  const token = "0x1111111111111111111111111111111111111111";
  it("allows a faucet token on a testnet", () => expect(paymentTokenRefusal({ chainId: ARC, address: token, faucet: true }, {})).toBeNull());
  it("refuses an unknown network", () => expect(paymentTokenRefusal({ chainId: 1, address: token, faucet: false }, {})).toMatch(/not served/));
  it("refuses the network's own USDC, whatever its case", () => {
    expect(paymentTokenRefusal({ chainId: ARC, address: "0x3600000000000000000000000000000000000000", faucet: false }, { [`BILLING_USDC_${ARC}`]: "0x3600000000000000000000000000000000000000" })).toMatch(/USDC/);
  });
});
