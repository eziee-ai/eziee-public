import { BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError, ExecutionRevertedError, HttpRequestError, InternalRpcError, MethodNotFoundRpcError, RpcRequestError, TimeoutError, erc20Abi, getAddress, hexToString, isAddress, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { clean } from "@repo/protocols/text";
import type { Token } from "@repo/protocols/types";
import { MAX_DECIMALS, NAME_MAX, SYMBOL_MAX, type CustomToken } from "./customTokens";

/** Older tokens, MKR among them, return `symbol` and `name` as a fixed 32 bytes rather than a string. */
export const bytes32MetadataAbi = parseAbi(["function symbol() view returns (bytes32)", "function name() view returns (bytes32)"]);

/** The two reads a token check needs. A `PublicClient` has both; see `tokenReader`. */
export interface TokenReader {
  getCode(args: { address: Address }): Promise<Hex | undefined>;
  readContract(
    args:
      | { address: Address; abi: typeof erc20Abi; functionName: "symbol" | "name" | "decimals" }
      | { address: Address; abi: typeof bytes32MetadataAbi; functionName: "symbol" | "name" }
      | { address: Address; abi: typeof erc20Abi; functionName: "balanceOf"; args: readonly [Address] },
  ): Promise<unknown>;
}

export function tokenReader(client: PublicClient): TokenReader {
  return {
    getCode: ({ address }) => client.getCode({ address }),
    readContract: (call) => {
      if (call.functionName === "balanceOf") return client.readContract({ address: call.address, abi: call.abi, functionName: "balanceOf", args: call.args });
      if (call.abi === bytes32MetadataAbi) return client.readContract({ address: call.address, abi: bytes32MetadataAbi, functionName: call.functionName as "symbol" | "name" });
      return client.readContract({ address: call.address, abi: erc20Abi, functionName: call.functionName });
    },
  };
}

export type TokenCheck =
  | { kind: "invalid-address"; reason: string }
  | { kind: "reviewed"; token: Token }
  | { kind: "unreviewed"; token: CustomToken }
  | { kind: "not-a-contract" }
  | { kind: "not-erc20"; reason: string };

/** The chain could not be asked. That is not an answer about the token, so it is never shown as one. */
export class TokenCheckUnavailable extends Error {
  constructor(cause: unknown) {
    super("The token could not be checked right now.", { cause });
    this.name = "TokenCheckUnavailable";
  }
}

/** The contract's data did not decode as the ABI said. 32 bytes read as a string throw `IntegerOutOfRangeError`. */
function isDecodeError(error: unknown): boolean {
  return error instanceof BaseError && Boolean(error.walk((e) => e instanceof Error && /Decoding|PositionOutOfBounds|SliceOffsetOutOfBounds|InvalidBytesBoolean|IntegerOutOfRange/.test(e.name)));
}

/** The EVM stopped the call without a revert: an old or fallback-less contract hitting an invalid opcode, running out of gas, or a node's own "VM execution error". */
const HALT = /invalid opcode|invalid jump|bad instruction|stack underflow|out of gas|vm execution error/i;
const VM_EXECUTION_ERROR_CODE = -32015;
function isHalt(e: unknown): boolean {
  // viem maps the node's code to one of its RpcError classes and keeps the node's own words in `details`.
  return e instanceof BaseError && (("code" in e && e.code === VM_EXECUTION_ERROR_CODE) || HALT.test(e.details));
}

/**
 * The contract answered, and the answer was not an ERC-20's: a revert, a halt, no data, or data that does not decode.
 *
 * A revert or halt is looked for first, because a node may report one under any code. Only then is a failed request an
 * outage: viem turns an internal node error that carries a message into `ContractFunctionRevertedError`, so that
 * class alone does not mean the contract refused.
 */
function isContractAnswer(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false;
  if (isDecodeError(error) || error.walk((e) => e instanceof ExecutionRevertedError || e instanceof ContractFunctionZeroDataError || isHalt(e))) return true;
  const outage = error.walk(
    (e) => e instanceof InternalRpcError || e instanceof HttpRequestError || e instanceof TimeoutError || (e instanceof RpcRequestError && e.code !== ExecutionRevertedError.code && e.code !== MethodNotFoundRpcError.code),
  );
  if (outage) return false;
  return Boolean(error.walk((e) => e instanceof ContractFunctionRevertedError));
}

/** A `symbol` or `name` read, retried as bytes32 when the string did not decode. A failed retry is judged like any other read. */
async function readText(reader: TokenReader, address: Address, functionName: "symbol" | "name"): Promise<unknown> {
  try {
    return await reader.readContract({ address, abi: erc20Abi, functionName });
  } catch (error) {
    if (!isDecodeError(error)) throw error;
    const raw = await reader.readContract({ address, abi: bytes32MetadataAbi, functionName });
    if (typeof raw !== "string" || !raw.startsWith("0x")) return raw;
    return hexToString(raw as Hex).replace(/\0+$/, "");
  }
}

/**
 * Checks an address before it is stored as a token: a real address, contract code at it, and
 * `symbol`, `name` and `decimals` that read as an ERC-20's, and a `balanceOf(account)` that answers,
 * since a token whose balance cannot be read could only ever be listed as unknown. One `readContract`
 * each, so no chain needs Multicall3. A token already on the reviewed list is reported as such and never re-added.
 */
export async function verifyToken(reader: TokenReader, chainId: number, input: string, registry: readonly Token[], account: Address): Promise<TokenCheck> {
  const text = input.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(text)) return { kind: "invalid-address", reason: "That is not a full address. It must be 0x followed by 40 characters." };
  // Mixed case carries an EIP-55 checksum; all one case carries none and is accepted.
  const hex = text.slice(2);
  const hasChecksum = hex !== hex.toLowerCase() && hex !== hex.toUpperCase();
  if (hasChecksum && !isAddress(text, { strict: true })) return { kind: "invalid-address", reason: "That address fails its checksum, so a character is wrong." };
  const address = getAddress(`0x${hex.toLowerCase()}`);

  const listed = registry.find((t) => t.chainId === chainId && t.address.toLowerCase() === address.toLowerCase());
  if (listed) return { kind: "reviewed", token: listed };

  let code: Hex | undefined;
  try {
    code = await reader.getCode({ address });
  } catch (error) {
    throw new TokenCheckUnavailable(error);
  }
  if (!code || code === "0x") return { kind: "not-a-contract" };

  const functions = ["symbol", "name", "decimals", "balanceOf"] as const;
  const reads = await Promise.allSettled(
    functions.map((functionName) =>
      functionName === "balanceOf" ? reader.readContract({ address, abi: erc20Abi, functionName, args: [account] }) : functionName === "decimals" ? reader.readContract({ address, abi: erc20Abi, functionName }) : readText(reader, address, functionName),
    ),
  );
  for (const [i, read] of reads.entries()) {
    if (read.status === "fulfilled") continue;
    if (!isContractAnswer(read.reason)) throw new TokenCheckUnavailable(read.reason);
    return { kind: "not-erc20", reason: `It does not answer ${functions[i]}().` };
  }
  const [symbolRaw, nameRaw, decimalsRaw] = reads.map((r) => (r as PromiseFulfilledResult<unknown>).value);

  const decimals = typeof decimalsRaw === "bigint" ? Number(decimalsRaw) : decimalsRaw;
  if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) return { kind: "not-erc20", reason: `Its decimals value, ${String(decimalsRaw)}, is outside 0 to ${MAX_DECIMALS}.` };
  const symbol = clean(symbolRaw, SYMBOL_MAX);
  if (symbol === "") return { kind: "not-erc20", reason: "Its symbol is empty." };
  const name = clean(nameRaw, NAME_MAX) || symbol;
  return { kind: "unreviewed", token: { address, symbol, name, decimals } };
}
