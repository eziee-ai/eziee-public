import type { Address, Hex } from "viem";
import { walletChains, walletConfig } from "../config";
import { normalise, safely } from "./evaluate";
import { classify } from "./policy";
import { ERR, WalletFrameError, type WalletRpc } from "./protocol";
import { addRule, reserveSpend } from "./ruleStore";
import { dayKey, validateRule, type Rule } from "./rules";
import { ruleEligibility } from "./scope";
import { executeSigned } from "./signer";

/**
 * "Always allow…": save a rule and sign the transaction it was made from.
 *
 * Runs in the frame, on the user's click in the frame. The page hands over a
 * draft, and NOTHING about it is taken on trust: the transaction is decoded
 * again here, and the rule must describe exactly that decoded action (same
 * protocol, action, chain and token, and wide enough for this very spend)
 * before it is validated, saved, counted and signed. A rule that does not fit
 * the transaction on screen is a rule the user never saw.
 */

const refuse = (message: string) => new WalletFrameError({ code: ERR.INVALID_PARAMS, message });

const sameToken = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export async function allowAlways(
  chainId: number,
  rpc: WalletRpc,
  rule: Rule,
  session: { account: Address; expiresAt: number | null; now: number },
  sign: (chainId: number, rpc: WalletRpc) => Promise<Hex> = executeSigned,
): Promise<Hex> {
  if (!sameToken(rule.account, session.account)) throw refuse("The rule is for a different account than the one signed in.");

  // The static floor first: transfers, authorizations and the rest can never be covered by a rule.
  if (classify(chainId, rpc).reason !== "needs a rule") throw refuse("This kind of request always asks; a rule cannot cover it.");
  const tx = normalise(chainId, rpc);
  if (!tx) throw refuse("The transaction is malformed.");

  const decoded = await safely(() => walletConfig().decodeAction?.(tx, session.account));
  const eligibility = ruleEligibility(decoded);
  if (!decoded || !eligibility.eligible) throw refuse(eligibility.eligible ? "This is not a recognised protocol action." : eligibility.reason);

  if (rule.protocol !== decoded.protocol || rule.action !== decoded.action || rule.chainId !== decoded.chainId || decoded.chainId !== chainId) throw refuse("The rule does not describe this action.");
  // A rule covers approvals to the contract it names. That has to be the contract THIS action calls, and nothing a caller chose.
  if (rule.spenderKey !== decoded.contract) throw refuse("The rule does not name the contract this action calls.");
  const spend = decoded.spends ? decoded.spend[0]! : null;
  if (spend) {
    if (rule.token === "any" || !sameToken(rule.token, spend.token)) throw refuse("The rule names a different token than this action spends.");
    if (spend.amount > rule.maxPerTx) throw refuse("The limit per transaction is lower than this transaction.");
  } else if (rule.token !== "any") {
    throw refuse("This action spends nothing, so its rule names no token.");
  }

  const problem = validateRule(rule, { now: session.now, sessionExpiresAt: session.expiresAt, chainIds: walletChains().map((c) => c.id), spends: decoded.spends });
  if (problem) throw refuse(problem);

  await addRule(rule);
  // This spend counts against the new rule's day like any later one.
  if (spend && !(await reserveSpend(rule.id, dayKey(session.now), spend.amount, rule.maxPerDay))) throw refuse("The limit per day is lower than this transaction.");
  return sign(chainId, rpc);
}
