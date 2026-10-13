import { ContractFunctionRevertedError, ContractFunctionZeroDataError, HttpRequestError, createPublicClient, custom, erc20Abi, getAddress, stringToHex, toFunctionSelector, type Address, type Hex, type PublicClient } from "viem";
import { describe, expect, it } from "vitest";
import type { Token } from "@repo/protocols/types";
import { TokenCheckUnavailable, tokenReader, verifyToken, type TokenReader } from "./verifyToken";

const ARC = 5042002;
const ADDRESS = "0x1111111111111111111111111111111111111111" as Address;
const ACCOUNT = "0x0000000000000000000000000000000000001001" as Address;
const USDC: Token = { chainId: ARC, address: "0x3600000000000000000000000000000000000000", symbol: "USDC", name: "USD Coin", decimals: 6, trust: "canonical" };

type Answers = { code?: Hex | undefined | Error; symbol?: unknown; name?: unknown; decimals?: unknown; balanceOf?: unknown };

function stub(answers: Answers) {
  const calls: string[] = [];
  const reader: TokenReader = {
    async getCode() {
      calls.push("getCode");
      if (answers.code instanceof Error) throw answers.code;
      return "code" in answers ? (answers.code as Hex | undefined) : "0x6000";
    },
    async readContract(call) {
      const { functionName, abi } = call;
      calls.push(functionName);
      // The happy path reads with the ERC-20 ABI only; the bytes32 retry is exercised through viem below.
      expect(abi).toBe(erc20Abi);
      if (call.functionName === "balanceOf") expect(call.args).toEqual([ACCOUNT]);
      const value = (answers as Record<string, unknown>)[functionName];
      if (value instanceof Error) throw value;
      return value;
    },
  };
  return { reader, calls };
}

const good = { symbol: "TEST", name: "Test Token", decimals: 6, balanceOf: 0n };

describe("verifyToken", () => {
  it("rejects text that is not an address, before any read", async () => {
    const { reader, calls } = stub(good);
    for (const bad of ["", "0x1234", "hello", `${ADDRESS}00`]) {
      expect(await verifyToken(reader, ARC, bad, [], ACCOUNT)).toMatchObject({ kind: "invalid-address" });
    }
    expect(calls).toEqual([]);
  });

  it("rejects a mixed-case address whose checksum is wrong", async () => {
    const { reader } = stub(good);
    const right = getAddress("0xabcdef0123456789abcdef0123456789abcdef01");
    const wrong = right.replace("A", "a").replace(/b/, "B");
    expect(await verifyToken(reader, ARC, wrong, [], ACCOUNT)).toMatchObject({ kind: "invalid-address" });
  });

  it("says a listed token is already reviewed, in any case", async () => {
    const { reader } = stub(good);
    expect(await verifyToken(reader, ARC, USDC.address.toLowerCase(), [USDC], ACCOUNT)).toEqual({ kind: "reviewed", token: USDC });
  });

  it("says an address with no code is not a contract", async () => {
    for (const code of ["0x", undefined] as const) {
      const { reader, calls } = stub({ ...good, code });
      expect(await verifyToken(reader, ARC, ADDRESS, [USDC], ACCOUNT)).toEqual({ kind: "not-a-contract" });
      expect(calls).toEqual(["getCode"]);
    }
  });

  it("reads symbol, name and decimals of an unreviewed token, one call each", async () => {
    const { reader, calls } = stub(good);
    const result = await verifyToken(reader, ARC, ADDRESS.toLowerCase(), [USDC], ACCOUNT);
    expect(result).toEqual({ kind: "unreviewed", token: { address: getAddress(ADDRESS), symbol: "TEST", name: "Test Token", decimals: 6 } });
    expect(calls.sort()).toEqual(["balanceOf", "decimals", "getCode", "name", "symbol"]);
  });

  it("cleans the symbol and name, and caps the symbol at 20 characters", async () => {
    const { reader } = stub({ symbol: " A\u202eB\u0000C  ", name: "<b>Name</b>", decimals: 18n });
    const result = await verifyToken(reader, ARC, ADDRESS, [], ACCOUNT);
    expect(result.kind).toBe("unreviewed");
    if (result.kind !== "unreviewed") return;
    const inert = (text: string) => Array.from(text).every((ch) => (ch.codePointAt(0) ?? 0) > 0x1f && ch !== "\u202e" && ch !== "<" && ch !== ">");
    expect(inert(result.token.symbol)).toBe(true);
    expect(result.token.name).not.toMatch(/[<>]/);
    expect(result.token.decimals).toBe(18);
    const long = stub({ ...good, symbol: "X".repeat(40) });
    const capped = await verifyToken(long.reader, ARC, ADDRESS, [], ACCOUNT);
    expect(capped.kind === "unreviewed" && capped.token.symbol.length).toBeLessThanOrEqual(20);
  });

  it("refuses decimals outside 0 to 36", async () => {
    for (const decimals of [37, 255, -1, 1.5]) {
      const { reader } = stub({ ...good, decimals });
      expect(await verifyToken(reader, ARC, ADDRESS, [], ACCOUNT)).toMatchObject({ kind: "not-erc20", reason: expect.stringContaining("decimals") });
    }
    const zero = stub({ ...good, decimals: 0 });
    expect(await verifyToken(zero.reader, ARC, ADDRESS, [], ACCOUNT)).toMatchObject({ kind: "unreviewed" });
  });

  it("refuses a contract that does not answer as an ERC-20, naming the read", async () => {
    const { reader } = stub({ ...good, symbol: new ContractFunctionZeroDataError({ functionName: "symbol" }) });
    expect(await verifyToken(reader, ARC, ADDRESS, [], ACCOUNT)).toEqual({ kind: "not-erc20", reason: "It does not answer symbol()." });
    const reverted = stub({ ...good, decimals: new ContractFunctionRevertedError({ abi: erc20Abi, functionName: "decimals" }) });
    expect(await verifyToken(reverted.reader, ARC, ADDRESS, [], ACCOUNT)).toEqual({ kind: "not-erc20", reason: "It does not answer decimals()." });
  });

  it("refuses a token whose balanceOf reverts, since its balance could never be shown", async () => {
    const { reader } = stub({ ...good, balanceOf: new ContractFunctionRevertedError({ abi: erc20Abi, functionName: "balanceOf" }) });
    expect(await verifyToken(reader, ARC, ADDRESS, [], ACCOUNT)).toEqual({ kind: "not-erc20", reason: "It does not answer balanceOf()." });
  });

  it("refuses an empty symbol", async () => {
    const { reader } = stub({ ...good, symbol: " \u200b " });
    expect(await verifyToken(reader, ARC, ADDRESS, [], ACCOUNT)).toEqual({ kind: "not-erc20", reason: "Its symbol is empty." });
  });

  it("does not turn a failed network read into a verdict", async () => {
    const down = new HttpRequestError({ url: "https://rpc.example" });
    await expect(verifyToken(stub({ ...good, code: down }).reader, ARC, ADDRESS, [], ACCOUNT)).rejects.toBeInstanceOf(TokenCheckUnavailable);
    await expect(verifyToken(stub({ ...good, name: down }).reader, ARC, ADDRESS, [], ACCOUNT)).rejects.toBeInstanceOf(TokenCheckUnavailable);
    await expect(verifyToken(stub({ ...good, balanceOf: down }).reader, ARC, ADDRESS, [], ACCOUNT)).rejects.toBeInstanceOf(TokenCheckUnavailable);
  });
});

/** A real viem client over a transport that answers each read as scripted, so viem's own error wrapping is what is tested. */
type Reply = Hex | { code: number; message: string; data?: Hex };
function chain(replies: Partial<Record<"symbol" | "name" | "decimals" | "balanceOf", Reply>>) {
  const selectors = Object.fromEntries((["symbol()", "name()", "decimals()", "balanceOf(address)"] as const).map((sig) => [toFunctionSelector(sig), sig.slice(0, sig.indexOf("("))]));
  const calls: string[] = [];
  const client = createPublicClient({
    transport: custom({
      async request({ method, params }) {
        if (method === "eth_getCode") return "0x6000";
        if (method !== "eth_call") throw new Error(`unexpected ${method}`);
        const data = (params as [{ data?: Hex; input?: Hex }])[0];
        const fn = selectors[(data.data ?? data.input ?? "0x").slice(0, 10)] as keyof typeof replies;
        calls.push(fn);
        const reply = replies[fn] ?? (fn === "decimals" ? word(6n) : fn === "balanceOf" ? word(0n) : undefined);
        if (reply === undefined) throw new Error(`no reply for ${fn}`);
        if (typeof reply === "string") return reply;
        throw Object.assign(new Error(reply.message), { code: reply.code, data: reply.data });
      },
    }, { retryCount: 0 }),
  }) as unknown as PublicClient;
  return { reader: tokenReader(client), calls };
}
const word = (value: bigint): Hex => `0x${value.toString(16).padStart(64, "0")}`;
const bytes32 = (text: string): Hex => stringToHex(text, { size: 32 });
/** An ABI-encoded `string` return, as a standard ERC-20 gives. */
const abiString = (text: string): Hex => {
  const hex = stringToHex(text).slice(2);
  return `0x${word(32n).slice(2)}${word(BigInt(hex.length / 2)).slice(2)}${hex.padEnd(Math.ceil(hex.length / 64) * 64, "0")}`;
};

describe("verifyToken through viem", () => {
  it("reads a token whose symbol and name are bytes32, as MKR's are", async () => {
    const { reader, calls } = chain({ symbol: bytes32("MKR"), name: bytes32("Maker"), decimals: word(18n) });
    expect(await verifyToken(reader, ARC, ADDRESS, [], ACCOUNT)).toEqual({ kind: "unreviewed", token: { address: getAddress(ADDRESS), symbol: "MKR", name: "Maker", decimals: 18 } });
    // Each of the two is asked twice: once as a string, then as bytes32.
    expect(calls.filter((c) => c === "symbol")).toHaveLength(2);
    expect(calls.filter((c) => c === "name")).toHaveLength(2);
  });

  it("asks once per read for a token that answers with strings", async () => {
    const { reader, calls } = chain({ symbol: abiString("TEST"), name: abiString("Test Token") });
    expect(await verifyToken(reader, ARC, ADDRESS, [], ACCOUNT)).toMatchObject({ kind: "unreviewed", token: { symbol: "TEST", name: "Test Token" } });
    expect(calls.sort()).toEqual(["balanceOf", "decimals", "name", "symbol"]);
  });

  it("refuses a bytes32 symbol that is all zeros", async () => {
    const { reader } = chain({ symbol: word(0n), name: bytes32("Maker") });
    expect(await verifyToken(reader, ARC, ADDRESS, [], ACCOUNT)).toEqual({ kind: "not-erc20", reason: "Its symbol is empty." });
  });

  it("still refuses a contract that reverts, however the node reports it", async () => {
    for (const revert of [{ code: 3, message: "execution reverted", data: "0x" as Hex }, { code: -32000, message: "execution reverted" }]) {
      const { reader } = chain({ symbol: revert, name: abiString("Test Token") });
      expect(await verifyToken(reader, ARC, ADDRESS, [], ACCOUNT)).toEqual({ kind: "not-erc20", reason: "It does not answer symbol()." });
    }
  });

  it("refuses a contract the EVM halts without a revert, as an old contract with no such function does", async () => {
    for (const halt of [{ code: -32000, message: "invalid opcode: INVALID" }, { code: -32000, message: "out of gas" }, { code: -32015, message: "VM execution error." }]) {
      const { reader } = chain({ symbol: halt, name: abiString("Test Token") });
      expect(await verifyToken(reader, ARC, ADDRESS, [], ACCOUNT)).toEqual({ kind: "not-erc20", reason: "It does not answer symbol()." });
    }
  });

  it("says the check is unavailable, not that it is no ERC-20, when the node has an internal error", async () => {
    const { reader } = chain({ symbol: abiString("TEST"), name: { code: -32603, message: "header not found" } });
    await expect(verifyToken(reader, ARC, ADDRESS, [], ACCOUNT)).rejects.toBeInstanceOf(TokenCheckUnavailable);
  });
});
