import { beforeEach, describe as suite, expect, it } from "vitest";
import { encodeFunctionData, erc20Abi, stringToHex } from "viem";
import { configureTestWallet, TEST_CHAIN_A, TEST_CHAIN_B } from "../testing/fixture";
import { classify, describe, describeLines, messageText } from "./policy";

/**
 * The decision that gates every signature the wallet frame makes.
 *
 * Every branch is pinned, because a wrong answer here is silent in exactly
 * the direction that costs money: a transfer sorted as "session" is signed
 * with no human in the loop, and nothing on screen says so.
 */

/** A chain the registry has never heard of. */
const NOWHERE = 424242;

const ENGINE = "0xaabbCCDdeeaABBcCddeeaABbCCDdEeAabBccDDee" as const;
const TOKEN = "0x1111111111111111111111111111111111111111" as const;
const STRANGER = "0x2222222222222222222222222222222222222222" as const;

beforeEach(() => {
  configureTestWallet();
});

function tx(fields: Record<string, unknown>) {
  return { method: "eth_sendTransaction", params: [fields] };
}

suite("classify — the floor", () => {
  it("never signs a call into a contract silently; that needs a rule", () => {
    expect(classify(TEST_CHAIN_A.id, tx({ to: ENGINE, data: "0xdeadbeef", value: "0x0" }))).toEqual({ tier: "confirm", reason: "needs a rule" });
  });

  it("never signs an approve silently on the floor, whoever the spender is", () => {
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [ENGINE, BigInt(1)] });
    expect(classify(TEST_CHAIN_A.id, tx({ to: TOKEN, data }))).toEqual({ tier: "confirm", reason: "needs a rule" });
  });

  it("never signs a text message silently on the floor", () => {
    const rpc = { method: "personal_sign", params: [stringToHex("Sign in\nNonce: 42"), STRANGER] };
    expect(classify(TEST_CHAIN_A.id, rpc).tier).toBe("confirm");
  });

  it("answers the identity reads", () => {
    for (const method of ["eth_accounts", "eth_requestAccounts", "eth_chainId"]) {
      expect(classify(TEST_CHAIN_A.id, { method }).tier).toBe("session");
    }
  });
});

suite("classify — confirm tier", () => {
  it("refuses a native transfer", () => {
    const verdict = classify(TEST_CHAIN_A.id, tx({ to: STRANGER, value: "0x10" }));
    expect(verdict.tier).toBe("confirm");
    expect(verdict.reason).toMatch(/native transfer/);
  });

  it("refuses an ERC-20 transfer", () => {
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [STRANGER, BigInt(5)] });
    expect(classify(TEST_CHAIN_A.id, tx({ to: TOKEN, data })).tier).toBe("confirm");
  });

  it("refuses transferFrom", () => {
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "transferFrom",
      args: [STRANGER, STRANGER, BigInt(5)],
    });
    expect(classify(TEST_CHAIN_A.id, tx({ to: TOKEN, data })).tier).toBe("confirm");
  });

  it("refuses an approve to an unknown spender on the floor; only a rule could ever cover an approve", () => {
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [STRANGER, BigInt(1)] });
    expect(classify(TEST_CHAIN_A.id, tx({ to: TOKEN, data }))).toEqual({ tier: "confirm", reason: "needs a rule" });
  });

  it("names transfers as always-confirm, so no rule path is even consulted for them", () => {
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [STRANGER, BigInt(5)] });
    expect(classify(TEST_CHAIN_A.id, tx({ to: TOKEN, data })).reason).toBe("token transfer");
    expect(classify(TEST_CHAIN_A.id, tx({ to: STRANGER, value: "0x1" })).reason).toBe("native transfer");
    expect(classify(TEST_CHAIN_A.id, tx({ to: STRANGER, value: "0x1", data: "0x" })).reason).toBe("native transfer");
  });

  it("refuses a venue address from ANOTHER chain", () => {
    // The same bytes on another chain hold nothing the registry vouches for.
    expect(classify(TEST_CHAIN_B.id, tx({ to: ENGINE, data: "0x01" })).tier).toBe("confirm");
    expect(classify(NOWHERE, tx({ to: ENGINE, data: "0x01" })).tier).toBe("confirm");
  });

  it("refuses a transaction carrying an authorization list", () => {
    expect(classify(TEST_CHAIN_A.id, tx({ to: ENGINE, data: "0x01", authorizationList: [] })).reason).toMatch(
      /authorization/,
    );
  });

  it("refuses contract creation", () => {
    expect(classify(TEST_CHAIN_A.id, tx({ data: "0x6080" })).reason).toMatch(/contract creation/);
  });

  it("refuses a malformed transaction", () => {
    expect(classify(TEST_CHAIN_A.id, { method: "eth_sendTransaction", params: ["nope"] }).tier).toBe("confirm");
    expect(classify(TEST_CHAIN_A.id, { method: "eth_sendTransaction" }).tier).toBe("confirm");
  });

  it("sends a removed batch method to the confirm tier", () => {
    const verdict = classify(TEST_CHAIN_A.id, { method: "mera_sendBatch", params: [] } as never);
    expect(verdict.tier).toBe("confirm");
  });

  it("refuses typed data, always", () => {
    expect(classify(TEST_CHAIN_A.id, { method: "eth_signTypedData_v4", params: [STRANGER, "{}"] }).tier).toBe(
      "confirm",
    );
    expect(classify(TEST_CHAIN_A.id, { method: "eth_signTypedData", params: [STRANGER, "{}"] }).tier).toBe(
      "confirm",
    );
  });

  it("refuses a message that is not text", () => {
    // 32 bytes that happen to be a hash: a signature over something nobody read.
    const hash = `0x${"ab".repeat(32)}`;
    expect(classify(TEST_CHAIN_A.id, { method: "personal_sign", params: [hash, STRANGER] }).tier).toBe("confirm");
  });

  it("refuses an unknown method", () => {
    expect(classify(TEST_CHAIN_A.id, { method: "eth_sign", params: [] }).reason).toMatch(/unknown method/);
  });
});

suite("messageText", () => {
  it("decodes hex UTF-8", () => {
    expect(messageText(stringToHex("héllo"))).toBe("héllo");
  });
  it("accepts a plain string", () => {
    expect(messageText("hello")).toBe("hello");
  });
  it("rejects control characters", () => {
    expect(messageText(stringToHex("a\x00b"))).toBeNull();
    expect(messageText("a\x1Bb")).toBeNull();
  });
  it("keeps the whitespace a challenge uses", () => {
    expect(messageText("line one\nline two\ttabbed\r\n")).not.toBeNull();
  });
  it("rejects invalid UTF-8", () => {
    expect(messageText("0xff")).toBeNull();
  });
  it("rejects a non-string", () => {
    expect(messageText(42)).toBeNull();
    expect(messageText(undefined)).toBeNull();
  });
});

suite("messageText control characters", () => {
  it("accepts text with tab, newline and carriage return", () => {
    expect(messageText("line one\n\tline two\r\n")).toBe("line one\n\tline two\r\n");
  });

  it.each([0x00, 0x08, 0x0b, 0x0c, 0x0e, 0x1f, 0x7f])("rejects control byte 0x%s", (code) => {
    expect(messageText(`a${String.fromCharCode(code)}b`)).toBeNull();
  });
});

suite("describe + describeLines", () => {
  it("names a native send in the chain's own unit", () => {
    const d = describe(tx({ to: STRANGER, value: `0x${(BigInt(10) ** BigInt(18)).toString(16)}` }));
    expect(d.kind).toBe("transaction");
    expect(describeLines(TEST_CHAIN_A.id, d)).toEqual([`Send 1 ETH to 0x2222…2222`]);
  });

  it("names an ERC-20 transfer, in base units until decimals are known", () => {
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [STRANGER, BigInt(1500000)] });
    const d = describe(tx({ to: TOKEN, data }));
    expect(describeLines(TEST_CHAIN_A.id, d)).toEqual([`Send 1500000 base units of 0x1111…1111 to 0x2222…2222`]);
    expect(describeLines(TEST_CHAIN_A.id, d, { [TOKEN]: { symbol: "USDC", decimals: 6 } })).toEqual([
      `Send 1.5 USDC to 0x2222…2222`,
    ]);
  });

  it("names an approve with its spender", () => {
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [STRANGER, BigInt(7)] });
    expect(
      describeLines(TEST_CHAIN_A.id, describe(tx({ to: TOKEN, data })), { [TOKEN]: { symbol: "T", decimals: 0 } }),
    ).toEqual([`Allow 0x2222…2222 to spend 7 T`]);
  });

  it("names typed data by primary type and domain", () => {
    const json = JSON.stringify({ primaryType: "Permit", domain: { name: "USD Coin" } });
    expect(
      describeLines(TEST_CHAIN_A.id, describe({ method: "eth_signTypedData_v4", params: [STRANGER, json] })),
    ).toEqual(["Sign Permit for USD Coin"]);
  });

  it("quotes a text message and flags raw bytes", () => {
    expect(
      describeLines(TEST_CHAIN_A.id, describe({ method: "personal_sign", params: [stringToHex("hi"), STRANGER] })),
    ).toEqual(["Sign: “hi”"]);
    expect(
      describeLines(TEST_CHAIN_A.id, describe({ method: "personal_sign", params: ["0xff", STRANGER] })),
    ).toEqual(["Sign raw bytes"]);
  });

  it("says when a call also delegates", () => {
    const d = describe(tx({ to: ENGINE, data: "0x01", authorizationList: [] }));
    expect(describeLines(TEST_CHAIN_A.id, d)[1]).toMatch(/delegates/);
  });
});
