/**
 * The STATIC FLOOR of the wallet's signing policy, and how a request is described.
 *
 * The key lives on the wallet origin, and every signature is asked for over
 * `postMessage` by script on the app origin, which is exactly the script an XSS
 * on the app would be. So the frame cannot take the app's word for what a
 * request is. It decodes the request itself.
 *
 * `classify` answers only what needs no rules and no storage:
 *
 *   - **session**: identity reads. Nothing else is ever silent on this floor.
 *   - **confirm, always** (no rule can cover these, spec §5.3 step 1): a native
 *     transfer, an ERC-20 `transfer` or `transferFrom`, typed data (Permit and
 *     Permit2 are typed data, and there a signature, not a transaction, moves
 *     the funds), any message, an EIP-7702 authorization, contract creation, a
 *     malformed request, an unknown method.
 *   - **confirm, reason "needs a rule"**: any other well-formed transaction.
 *     Whether it may be signed silently is `evaluate`'s question (`evaluate.ts`):
 *     it is decoded by the app-injected protocol decoder and weighed against the
 *     user's own rules. With no rule, the answer is the confirm frame.
 *
 * The transfer checks sit HERE, below the injected decoder, on purpose: even a
 * decoder that wrongly called a token transfer a protocol action could not make
 * it silent.
 *
 * This replaces the ported static tier, where any call into a venue contract
 * and any text message signed silently.
 *
 * ## Pure, and tested
 *
 * No I/O. `classify` and `describe` take the request and answer.
 */

import { formatUnits, hexToString, type Address, type Hex } from "viem";
import { walletChains } from "../config";
import { ERR, isAddressLike, isHex, type FrameError, type WalletRpc } from "./protocol";

export type Tier = "session" | "confirm";

export interface Classification {
  tier: Tier;
  /** Why, in words a log line can carry. */
  reason: string;
}

/** `approve(address,uint256)` */
const APPROVE_SELECTOR = "0x095ea7b3";
/** `transfer(address,uint256)` */
const TRANSFER_SELECTOR = "0xa9059cbb";
/** `transferFrom(address,address,uint256)` */
const TRANSFER_FROM_SELECTOR = "0x23b872dd";

/** Every address the registry records for a chain, lower-cased. Empty for an unknown chain. */
interface TxLike {
  to?: unknown;
  data?: unknown;
  value?: unknown;
  authorizationList?: unknown;
}

function txOf(rpc: WalletRpc): TxLike | null {
  const first = Array.isArray(rpc.params) ? rpc.params[0] : undefined;
  return typeof first === "object" && first !== null ? (first as TxLike) : null;
}

function selectorOf(data: unknown): string | null {
  return isHex(data) && data.length >= 10 ? data.slice(0, 10).toLowerCase() : null;
}

/** The `address` argument at ABI word `index` of `data`, or null when too short. */
function addressArg(data: Hex, index: number): Address | null {
  const start = 10 + index * 64;
  const word = data.slice(start, start + 64);
  if (word.length !== 64) return null;
  return `0x${word.slice(24)}` as Address;
}

function uintArg(data: Hex, index: number): bigint | null {
  const start = 10 + index * 64;
  const word = data.slice(start, start + 64);
  if (word.length !== 64) return null;
  return BigInt(`0x${word}`);
}

/**
 * Is this message something a person could read?
 *
 * The identity flows sign sentences. A value that does not decode as UTF-8,
 * or decodes to control characters, is not one of them — it is bytes, and
 * bytes signed under `personal_sign` are a signature over something the
 * user was never shown. Those go to the confirm tier.
 */
export function messageText(data: unknown): string | null {
  let text: string;
  if (isHex(data)) {
    try {
      text = hexToString(data);
    } catch {
      return null;
    }
    // hexToString does not validate: re-encode and compare, so an invalid
    // byte sequence (which the decoder replaced with U+FFFD) is caught.
    if (text.includes("�")) return null;
  } else if (typeof data === "string") {
    text = data;
  } else {
    return null;
  }
  // Printable, plus the whitespace a multi-line challenge uses.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(text)) return null;
  return text;
}

export function classify(_chainId: number, rpc: WalletRpc): Classification {
  switch (rpc.method) {
    case "eth_accounts":
    case "eth_requestAccounts":
    case "eth_chainId":
      return { tier: "session", reason: "read" };

    case "personal_sign":
      // Never silent on the floor. `evaluate` lets exactly one message through: this app's sign-in.
      return { tier: "confirm", reason: "message" };

    case "eth_signTypedData_v4":
    case "eth_signTypedData":
      return { tier: "confirm", reason: "typed data" };

    case "eth_sendTransaction": {
      const tx = txOf(rpc);
      if (!tx) return { tier: "confirm", reason: "malformed transaction" };
      if (tx.authorizationList !== undefined) return { tier: "confirm", reason: "carries an authorization" };
      if (!isAddressLike(tx.to)) return { tier: "confirm", reason: "no recipient (contract creation)" };

      const selector = selectorOf(tx.data);
      if (selector === TRANSFER_SELECTOR || selector === TRANSFER_FROM_SELECTOR) {
        return { tier: "confirm", reason: "token transfer" };
      }
      if (tx.data !== undefined && !isHex(tx.data)) return { tier: "confirm", reason: "malformed transaction" };
      if (tx.data === undefined || tx.data === "0x") return { tier: "confirm", reason: "native transfer" };
      // Well-formed. Silent only if a rule covers what it decodes to; see evaluate.ts.
      return { tier: "confirm", reason: "needs a rule" };
    }

    default:
      // Read-only RPC (`eth_call`, `eth_estimateGas`, …) is forwarded to the
      // chain by the connector and never reaches the signer. Anything that
      // does reach it under an unknown name is refused, not guessed at.
      return { tier: "confirm", reason: `unknown method ${rpc.method}` };
  }
}

export const CONFIRM_REQUIRED_ERROR: FrameError = {
  code: ERR.CONFIRM_REQUIRED,
  message:
    "This request moves value and must be confirmed in the wallet's own confirm control, not signed silently.",
};

/* ------------------------------------------------------------------------ */
/* Describing a request, for the confirm frame                               */
/* ------------------------------------------------------------------------ */

export type DescribedCall =
  | { kind: "native"; to: Address; value: bigint }
  | { kind: "erc20-transfer"; token: Address; to: Address; amount: bigint }
  | { kind: "erc20-approve"; token: Address; spender: Address; amount: bigint }
  | { kind: "call"; to: Address; value: bigint; selector: string | null };

export type Description =
  | { kind: "transaction"; call: DescribedCall; authorization: boolean }
  | { kind: "typed"; primaryType: string; domainName: string | null }
  | { kind: "message"; text: string | null; hex: string | null }
  | { kind: "unknown"; method: string };

function bigintOf(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (isHex(value) && value.length > 2) return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  return BigInt(0);
}

function describeCall(to: unknown, data: unknown, value: unknown): DescribedCall | null {
  if (!isAddressLike(to)) return null;
  const v = bigintOf(value);
  const selector = selectorOf(data);
  if (selector === TRANSFER_SELECTOR) {
    const recipient = addressArg(data as Hex, 0);
    const amount = uintArg(data as Hex, 1);
    if (recipient && amount !== null) return { kind: "erc20-transfer", token: to, to: recipient, amount };
  }
  if (selector === APPROVE_SELECTOR) {
    const spender = addressArg(data as Hex, 0);
    const amount = uintArg(data as Hex, 1);
    if (spender && amount !== null) return { kind: "erc20-approve", token: to, spender, amount };
  }
  if (!isHex(data) || data === "0x") return { kind: "native", to, value: v };
  return { kind: "call", to, value: v, selector };
}

export function describe(rpc: WalletRpc): Description {
  switch (rpc.method) {
    case "eth_sendTransaction": {
      const tx = txOf(rpc);
      const call = tx ? describeCall(tx.to, tx.data, tx.value) : null;
      if (!call) return { kind: "unknown", method: rpc.method };
      return { kind: "transaction", call, authorization: tx?.authorizationList !== undefined };
    }
    case "eth_signTypedData_v4":
    case "eth_signTypedData": {
      const raw = Array.isArray(rpc.params) ? rpc.params[1] : undefined;
      try {
        const parsed = typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : (raw as Record<string, unknown>);
        const domain = parsed?.domain as { name?: unknown } | undefined;
        return {
          kind: "typed",
          primaryType: typeof parsed?.primaryType === "string" ? parsed.primaryType : "unknown",
          domainName: typeof domain?.name === "string" ? domain.name : null,
        };
      } catch {
        return { kind: "typed", primaryType: "unknown", domainName: null };
      }
    }
    case "personal_sign": {
      const data = Array.isArray(rpc.params) ? rpc.params[0] : undefined;
      const text = messageText(data);
      return { kind: "message", text, hex: text === null && isHex(data) ? data : null };
    }
    default:
      return { kind: "unknown", method: rpc.method };
  }
}

/** Optional display facts a caller may already know for a token. */
export interface TokenMeta {
  symbol?: string;
  decimals?: number;
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function nativeSymbol(chainId: number): { symbol: string; decimals: number } {
  const chain = walletChains().find((c) => c.id === chainId);
  return chain
    ? { symbol: chain.nativeCurrency.symbol, decimals: chain.nativeCurrency.decimals }
    : { symbol: "native", decimals: 18 };
}

function amountLabel(amount: bigint, meta: TokenMeta | undefined, token: Address): string {
  if (meta?.decimals !== undefined) {
    return `${formatUnits(amount, meta.decimals)} ${meta.symbol ?? shortAddress(token)}`;
  }
  // Without decimals the honest figure is the raw one, labelled as such.
  return `${amount.toString()} base units of ${meta?.symbol ?? shortAddress(token)}`;
}

/**
 * One sentence per thing the request does, for a person to read before
 * clicking. Full addresses are the caller's job (the withdraw sheet shows the
 * whole destination); this is the frame's independent restatement, and it
 * shortens so a line fits the control it sits above.
 */
export function describeLines(
  chainId: number,
  description: Description,
  tokens: Record<string, TokenMeta> = {},
): string[] {
  const native = nativeSymbol(chainId);
  const line = (call: DescribedCall): string => {
    switch (call.kind) {
      case "native":
        return `Send ${formatUnits(call.value, native.decimals)} ${native.symbol} to ${shortAddress(call.to)}`;
      case "erc20-transfer":
        return `Send ${amountLabel(call.amount, tokens[call.token.toLowerCase()], call.token)} to ${shortAddress(call.to)}`;
      case "erc20-approve":
        return `Allow ${shortAddress(call.spender)} to spend ${amountLabel(call.amount, tokens[call.token.toLowerCase()], call.token)}`;
      case "call": {
        const value = call.value > BigInt(0) ? ` with ${formatUnits(call.value, native.decimals)} ${native.symbol}` : "";
        return `Call ${shortAddress(call.to)}${value}${call.selector ? ` (${call.selector})` : ""}`;
      }
    }
  };

  switch (description.kind) {
    case "transaction":
      return [line(description.call), ...(description.authorization ? ["Also delegates this account's code for the transaction"] : [])];
    case "typed":
      return [`Sign ${description.primaryType}${description.domainName ? ` for ${description.domainName}` : ""}`];
    case "message":
      return [description.text !== null ? `Sign: “${description.text.slice(0, 140)}”` : "Sign raw bytes"];
    case "unknown":
      return [`Unknown request: ${description.method}`];
  }
}
