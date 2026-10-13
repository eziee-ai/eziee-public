import { decodeFunctionData, encodeFunctionData, erc20Abi, getAddress, maxUint256, toFunctionSelector, type AbiFunction, type Address, type Hex } from "viem";
import type { DecodedAction, DecodedApproval, Spend, TxRequest } from "../types";
import { callFunction, type Manifest, type ManifestAmountRef, type ManifestCall, type ManifestTokenRef } from "./schema";

/**
 * Calldata to meaning, from a manifest alone.
 *
 * PURE: no network, no clock, no randomness. The wallet frame runs this to
 * decide what a transaction is before it signs or draws a confirm card, so
 * every ambiguity resolves to `null` ("I do not know what this is"), which the
 * caller must treat as confirm-tier and unknown. It never throws.
 *
 * INVARIANT: a non-null result means `tx.to` is a manifest contract on
 * `tx.chainId`, the selector is one the manifest declares for that contract,
 * the calldata is the canonical ABI encoding of its arguments, any declared
 * recipient is the signer, and the native value attached equals the native spend
 * declared. Tokens that are not on the manifest's list are FLAGGED (`listed`,
 * `unlisted`), not trusted: callers never make or match a rule for such an action.
 */

const APPROVE_SELECTOR = toFunctionSelector("function approve(address,uint256)");

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** The value at a (possibly dotted) arg path in decoded args. */
function readArg(fn: AbiFunction, args: readonly unknown[], path: string): unknown {
  const [head, ...rest] = path.split(".");
  const index = fn.inputs.findIndex((input) => input.name === head);
  if (index < 0) return undefined;
  let value: unknown = args[index];
  for (const part of rest) {
    if (typeof value !== "object" || value === null) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function resolveToken(ref: ManifestTokenRef, fn: AbiFunction, args: readonly unknown[]): Address | "native" | undefined {
  if (ref === "native") return "native";
  if ("const" in ref) return ref.const;
  const value = readArg(fn, args, ref.arg);
  return typeof value === "string" ? (value as Address) : undefined;
}

function resolveAmount(ref: ManifestAmountRef, fn: AbiFunction, args: readonly unknown[], value: bigint): bigint | undefined {
  if (ref === "msg.value") return value;
  if ("const" in ref) return BigInt(ref.const);
  const arg = readArg(fn, args, ref.arg);
  // viem returns number for uint8..uint48 and bigint above; both are exact here.
  if (typeof arg === "bigint") return arg;
  if (typeof arg === "number" && Number.isSafeInteger(arg) && arg >= 0) return BigInt(arg);
  return undefined;
}

function contractKeyFor(manifest: Manifest, chainId: number, to: string): string | undefined {
  const contracts = manifest.contracts[String(chainId)];
  if (!contracts) return undefined;
  return Object.keys(contracts).find((key) => same(contracts[key]!.address, to));
}

function listedToken(manifest: Manifest, chainId: number, token: string): Address | undefined {
  return manifest.tokens[String(chainId)]?.find((t) => same(t.address, token))?.address;
}

function findCall(manifest: Manifest, contractKey: string, selector: string): { action: string; call: ManifestCall; fn: AbiFunction } | undefined {
  for (const [action, definition] of Object.entries(manifest.actions)) {
    for (const call of definition.calls) {
      if (call.contract !== contractKey) continue;
      const fn = callFunction(call.abi);
      if (toFunctionSelector(fn) === selector) return { action, call, fn };
    }
  }
  return undefined;
}

export function decodeAction(manifest: Manifest, tx: TxRequest, signer: Address): DecodedAction | null {
  try {
    if (!manifest.chains.includes(tx.chainId)) return null;
    const contract = contractKeyFor(manifest, tx.chainId, tx.to);
    if (!contract) return null;
    if (typeof tx.data !== "string" || tx.data.length < 10) return null;

    const found = findCall(manifest, contract, tx.data.slice(0, 10).toLowerCase());
    if (!found) return null;
    const { action, call, fn } = found;

    const { args = [] } = decodeFunctionData({ abi: [fn], data: tx.data as Hex });
    // One meaning per calldata. viem tolerates bytes appended after the arguments and dirty
    // upper bits in an address word; the EVM's ABI decoder reverts on the latter. Requiring the
    // canonical encoding means what was decoded here is byte-for-byte what will execute.
    if (encodeFunctionData({ abi: [fn], functionName: fn.name, args }).toLowerCase() !== tx.data.toLowerCase()) return null;

    const spend: Spend[] = [];
    let declaresNative = false;
    for (const entry of call.spend ?? []) {
      const token = resolveToken(entry.token, fn, args);
      const amount = resolveAmount(entry.amount, fn, args, tx.value);
      if (token === undefined || amount === undefined) return null;
      if (token === "native") {
        declaresNative = true;
        spend.push({ token, amount, listed: true });
      } else {
        const listed = listedToken(manifest, tx.chainId, token);
        spend.push({ token: listed ?? getAddress(token), amount, listed: listed !== undefined });
      }
    }
    // Native value must be accounted for exactly. A declared native spend that is smaller than
    // tx.value would let a rule sized for the declared amount sign away the difference.
    const declaredNative = spend.reduce((sum, entry) => (entry.token === "native" ? sum + entry.amount : sum), 0n);
    if (declaresNative ? declaredNative !== tx.value : tx.value !== 0n) return null;

    const decoded: DecodedAction = { protocol: manifest.id, action, chainId: tx.chainId, contract, spends: manifest.actions[action]!.spends, spend, unlisted: spend.some((entry) => !entry.listed) };
    if (manifest.actions[action]!.alwaysAsk) decoded.alwaysAsk = true;

    if (call.recipient) {
      const recipient = readArg(fn, args, call.recipient.arg);
      if (typeof recipient !== "string" || !same(recipient, signer)) return null;
      decoded.recipient = signer;
    }
    if (call.receive) {
      const token = resolveToken(call.receive.token, fn, args);
      if (token === undefined) return null;
      const listed = token === "native" ? token : listedToken(manifest, tx.chainId, token);
      // Flagged, never trusted: an unlisted receive token makes the whole action ineligible for a rule.
      const receive: NonNullable<DecodedAction["receive"]> = { token: listed ?? getAddress(token), listed: listed !== undefined };
      if (!receive.listed) decoded.unlisted = true;
      if (call.receive.minAmount !== undefined) {
        const minAmount = resolveAmount(call.receive.minAmount, fn, args, tx.value);
        if (minAmount === undefined) return null;
        receive.minAmount = minAmount;
      }
      decoded.receive = receive;
    }
    if (call.deadline) {
      const deadline = resolveAmount(call.deadline, fn, args, tx.value);
      if (deadline === undefined) return null;
      decoded.deadline = deadline;
    }
    return decoded;
  } catch {
    return null;
  }
}

/**
 * An ERC-20 approval that belongs to a protocol: a listed token approving one
 * of the manifest's `router`-role contracts. Anything else is `null`, and per
 * spec §5.3 an approval this does not recognise is always confirm-tier.
 */
export function decodeApproval(manifest: Manifest, tx: TxRequest): DecodedApproval | null {
  try {
    if (!manifest.chains.includes(tx.chainId) || tx.value !== 0n) return null;
    if (typeof tx.data !== "string" || tx.data.slice(0, 10).toLowerCase() !== APPROVE_SELECTOR) return null;
    const token = listedToken(manifest, tx.chainId, tx.to);
    if (!token) return null;

    const { args } = decodeFunctionData({ abi: erc20Abi, data: tx.data as Hex });
    const [spender, amount] = args as readonly [Address, bigint];
    // Same canonical-encoding rule as decodeAction: one meaning per calldata.
    if (encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }).toLowerCase() !== tx.data.toLowerCase()) return null;
    const spenderKey = contractKeyFor(manifest, tx.chainId, spender);
    if (!spenderKey) return null;
    const entry = manifest.contracts[String(tx.chainId)]![spenderKey]!;
    if (entry.role !== "router") return null;

    return { protocol: manifest.id, chainId: tx.chainId, token, spender: entry.address, spenderKey, amount, unlimited: amount === maxUint256 };
  } catch {
    return null;
  }
}
