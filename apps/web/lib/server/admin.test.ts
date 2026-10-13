import { describe, expect, it } from "vitest";
import { adminAddresses, isAdmin } from "./admin";

const OWNER = "0xF8FB4672170607C95663f4Cc674dDb1386b7CfE0";

describe("admins", () => {
  it("are nobody when the list is unset", () => {
    expect(adminAddresses({}).size).toBe(0);
    expect(isAdmin(OWNER, {})).toBe(false);
  });

  it("match an address whatever its case, and skip entries that are not addresses", () => {
    const env = { ADMIN_ADDRESSES: ` ${OWNER.toLowerCase()} , not-an-address,` };
    expect(adminAddresses(env).size).toBe(1);
    expect(isAdmin(OWNER, env)).toBe(true);
    expect(isAdmin("0x0000000000000000000000000000000000001001", env)).toBe(false);
    expect(isAdmin(null, env)).toBe(false);
  });
});

describe("the end-to-end admin switch", () => {
  it("does nothing without the test hooks, so it cannot open /admin on a real deployment", () => {
    // This test process does not set E2E_TEST_HOOKS, as no deployment does.
    expect(isAdmin("0x0000000000000000000000000000000000001001", { E2E_ADMIN_ANY: "1" })).toBe(false);
  });
});
