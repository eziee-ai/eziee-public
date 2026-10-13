import type { Address, Hex } from "viem";
import { isSignInMessage } from "../signIn";
import { walletConfig, type WalletTx } from "../config";
import { classify, messageText, type Classification } from "./policy";
import { isAddressLike, isHex, type WalletRpc } from "./protocol";
import { listRules, reserveSpend } from "./ruleStore";
import { dayKey, matchAction, matchApproval, type RuleContext } from "./rules";

/**
 * The decision that gates every silent signature (spec §5.3).
 *
 * Order, and every step defaults to "ask":
 *  1. The static floor (`classify`): reads are silent; typed data, authorizations,
 *     contract creation, malformed requests and unknown methods always ask.
 *  2. A text message is silent only if it is exactly this app's sign-in
 *     template for this account, issued just now.
 *  3. A transaction is decoded by the injected decoder. Not decodable (a native
 *     or token transfer, an unknown contract, a decoder error) means ask.
 *  4. A decoded action is silent only under an unexpired rule of THIS account
 *     that covers it, and, if it spends, only after the day's cap has been
 *     reserved atomically. An approval is silent only when exact, to the
 *     protocol's router, and within a spending rule for that token.
 *
 * INVARIANT: no request is signed without either a matching unexpired rule
 * evaluated on frame-decoded calldata, or a real click in the confirm frame.
 */

export interface Verdict extends Classification {
  /** The rule that covered a silent signature. */
  ruleId?: string;
}

const ask = (reason: string): Verdict => ({ tier: "confirm", reason });

export { isSignInMessage, signInMessage } from "../signIn";

/* ---------------------------- transactions ---------------------------- */

/**
 * The only fields a transaction may carry and still be DESCRIBED BY ITS DECODE. `executeSigned`
 * forwards what it is given, so a field the decoder never saw is a field the user never saw: an
 * EIP-7702 `authorizationList` beside valid swap calldata would read as "a swap" and sign a
 * delegation. Anything outside this set makes the request undecodable here, which sends it to
 * the raw description and the always-ask path. `gas` is allowed: it bounds a fee, names nothing.
 */
const DECODABLE_KEYS: ReadonlySet<string> = new Set(["from", "to", "data", "value", "gas"]);

/** The transaction inside an `eth_sendTransaction` request, normalised for a decoder, or null if it is malformed or carries anything more. */
export function normalise(chainId: number, rpc: WalletRpc): WalletTx | null {
  const first = Array.isArray(rpc.params) ? (rpc.params[0] as Record<string, unknown> | undefined) : undefined;
  if (typeof first !== "object" || first === null || !isAddressLike(first.to)) return null;
  if (Array.isArray(rpc.params) && rpc.params.length !== 1) return null;
  if (Object.keys(first).some((key) => !DECODABLE_KEYS.has(key))) return null;
  const data = first.data === undefined ? "0x" : first.data;
  if (!isHex(data)) return null;
  let value = 0n;
  if (first.value !== undefined) {
    if (!isHex(first.value) || first.value.length <= 2) return null;
    value = BigInt(first.value);
  }
  return { chainId, to: first.to as Address, data: data as Hex, value };
}

/** A decoder is injected code, and may read the chain: a throw or a rejection means "I do not know", never "allowed". */
export async function safely<T>(fn: () => T | null | undefined | Promise<T | null | undefined>): Promise<T | null> {
  try {
    return (await fn()) ?? null;
  } catch {
    return null;
  }
}

export async function evaluate(chainId: number, rpc: WalletRpc, ctx: RuleContext): Promise<Verdict> {
  const floor = classify(chainId, rpc);
  if (floor.tier === "session") return floor;

  if (rpc.method === "personal_sign") {
    const text = messageText(Array.isArray(rpc.params) ? rpc.params[0] : undefined);
    if (text !== null && isSignInMessage(text, { brand: walletConfig().brand, account: ctx.account, origin: ctx.origin, now: ctx.now })) return { tier: "session", reason: "sign-in" };
    return ask("message is not this app's sign-in");
  }

  if (rpc.method !== "eth_sendTransaction" || floor.reason !== "needs a rule") return floor;

  const tx = normalise(chainId, rpc);
  if (!tx) return ask("malformed transaction");
  const config = walletConfig();

  const approval = await safely(() => config.decodeApproval?.(tx));
  if (approval) {
    const rules = await listRules();
    return matchApproval(rules, approval, ctx) ? { tier: "session", reason: "exact approval within a rule" } : ask("approval outside any rule");
  }

  const decoded = await safely(() => config.decodeAction?.(tx, ctx.account));
  if (!decoded || decoded.chainId !== chainId) return ask("not a recognised protocol action");

  const candidates = matchAction(await listRules(), decoded, ctx);
  for (const rule of candidates) {
    if (!decoded.spends) return { tier: "session", reason: "covered by a rule", ruleId: rule.id };
    const amount = decoded.spend[0]!.amount;
    // Reserved BEFORE signing, atomically, and never refunded: a cap can be under-used, not exceeded.
    if (await reserveSpend(rule.id, dayKey(ctx.now), amount, rule.maxPerDay)) return { tier: "session", reason: "covered by a rule", ruleId: rule.id };
  }
  return ask(candidates.length > 0 ? "the day's limit is used up" : "no rule covers this");
}
