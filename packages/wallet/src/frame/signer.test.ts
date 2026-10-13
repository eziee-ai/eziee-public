import { beforeEach, describe, expect, it } from "vitest";
import { configureTestWallet } from "../testing/fixture";
import { ERR, WalletFrameError } from "./protocol";
import { executeSigned } from "./signer";

describe("executeSigned chain lookup", () => {
  beforeEach(() => configureTestWallet());

  it("rejects an unconfigured chain with a typed INVALID_PARAMS frame error", async () => {
    const attempt = executeSigned(1, { method: "personal_sign", params: ["0x00", "0x0000000000000000000000000000000000000000"] } as never);
    await expect(attempt).rejects.toBeInstanceOf(WalletFrameError);
    await expect(attempt).rejects.toMatchObject({ code: ERR.INVALID_PARAMS });
  });
});
