import { parseUnits, type Address } from "viem";
import type { DecodedForRules, Rule } from "./rules";

/**
 * The "Always allow…" scope editor's logic, kept out of the React page so it is
 * tested: whether a rule may be offered at all, what it is prefilled with, and
 * how a typed limit becomes base units. The frame still runs `validateRule` on
 * whatever comes out of the editor; nothing here is the gate.
 */

export type Eligibility = { eligible: true } | { eligible: false; reason: string };

/** A rule is only offered for something `matchAction` could later match. */
export function ruleEligibility(decoded: DecodedForRules | null): Eligibility {
  if (!decoded) return { eligible: false, reason: "This is not a recognised protocol action, so it always asks." };
  if (decoded.alwaysAsk) return { eligible: false, reason: decoded.alwaysAskReason ?? "This can give something up that a limit cannot describe, such as fees that have not vested yet. It always asks." };
  if (decoded.unlisted || decoded.spend.some((entry) => entry.listed === false)) return { eligible: false, reason: "This involves a token that is not on the protocol's reviewed list, so it always asks." };
  if (decoded.receive?.minAmount !== undefined && decoded.receive.minAmount <= 0n) return { eligible: false, reason: "This accepts nothing in return, so it always asks." };
  if (!decoded.spends) return decoded.spend.length === 0 ? { eligible: true } : { eligible: false, reason: "This action's description contradicts itself, so it always asks." };
  if (decoded.spend.length !== 1) return { eligible: false, reason: "This action spends more than one token, and a rule covers one token. It always asks." };
  if (decoded.spend[0]!.amount <= 0n) return { eligible: false, reason: "This action spends nothing measurable, so it always asks." };
  return { eligible: true };
}

const DAILY_MULTIPLE = 4n;

/** Prefilled from the action on screen: never broader than what the user is already looking at. */
export function draftRule(decoded: DecodedForRules, ctx: { id: string; account: Address; now: number; sessionExpiresAt: number }): Rule {
  const spend = decoded.spends ? decoded.spend[0] : undefined;
  return {
    id: ctx.id,
    account: ctx.account,
    protocol: decoded.protocol,
    action: decoded.action,
    chainId: decoded.chainId,
    token: spend ? spend.token : "any",
    maxPerTx: spend ? spend.amount : 0n,
    maxPerDay: spend ? spend.amount * DAILY_MULTIPLE : 0n,
    expiresAt: ctx.sessionExpiresAt,
    persistent: false,
    sessionKey: ctx.sessionExpiresAt,
    createdAt: ctx.now,
    ...(decoded.contract ? { spenderKey: decoded.contract } : {}),
  };
}

/** A typed limit as base units, or null. Plain positive decimals only, within the token's decimals. */
export function parseCap(text: string, decimals: number): bigint | null {
  const value = text.trim();
  if (!/^(0|[1-9][0-9]{0,40})(\.[0-9]+)?$/.test(value)) return null;
  if ((value.split(".")[1] ?? "").length > decimals) return null;
  const units = parseUnits(value, decimals);
  return units > 0n ? units : null;
}
