import type { Address } from "viem";

/**
 * Permission rules: what the wallet may sign WITHOUT asking (spec §5.3).
 *
 * Pure functions only. Storage and the atomic daily-cap reservation live in
 * `ruleStore.ts`; deciding what a transaction IS lives with whoever injected
 * `decodeAction` (see `config.ts`). This file answers one question: given what
 * a transaction was decoded to, does a rule the user made cover it?
 *
 * DEFAULT DENY. Every function here returns "no" for anything it does not
 * positively recognise, and a "no" means the visible confirm frame.
 *
 * INVARIANT: a spending rule names exactly one token, so its caps are always in
 * that token's own base units and no price or decimals assumption exists here.
 * INVARIANT: an `"any"`-token rule can never cover an action that spends.
 * INVARIANT: a rule belongs to one account. A second passkey wallet unlocked on
 * the same device inherits nothing.
 *
 * WHAT A CAP IS, plainly: a rule caps what goes IN. It does not know prices, so
 * it cannot judge whether what comes back is fair. If this app were compromised,
 * an attacker could make bad trades inside a rule, up to its daily limit. The
 * daily limit is therefore the most a rule can lose in a day, and the scope
 * editor says so. Only a declared minimum of ZERO is refused outright.
 */

const MAX_UINT256 = 2n ** 256n - 1n;
const MAX_PERSISTENT_MS = 30 * 24 * 60 * 60 * 1000;

export interface Rule {
  id: string;
  /** The wallet address this rule was made for. */
  account: Address;
  protocol: string;
  action: string;
  chainId: number;
  /** One token, the chain's native asset, or `"any"` for actions that spend nothing. */
  token: Address | "native" | "any";
  /** Base units of `token`. Zero when `token` is `"any"`. */
  maxPerTx: bigint;
  /** Base units of `token` per UTC day. Zero when `token` is `"any"`. */
  maxPerDay: bigint;
  /** ms epoch. */
  expiresAt: number;
  /** false: removed when the session ends. */
  persistent: boolean;
  /**
   * For a session rule: the expiry stamp of the session it was made in, which is
   * unique per unlock. A session rule is only live in THAT session, so ending a
   * session kills its rules even if deleting them from storage failed. Null on a
   * persistent rule.
   */
  sessionKey: number | null;
  createdAt: number;
  /**
   * The manifest key of the contract this rule's action is called on, which is also the only contract that action
   * needs an allowance for. An approval is covered by this rule only when its spender is THAT contract: a rule for
   * placing orders must not quietly grant an allowance to some other contract of the same protocol.
   * Absent on rules saved before this existed; those cover no approval, so the wallet asks.
   */
  spenderKey?: string;
}

/** Who is asking, and when. `sessionKey` is the current session's expiry stamp, or null with no session. */
export interface RuleContext {
  account: Address;
  now: number;
  sessionKey: number | null;
  /** The origin of the window that made the request, as the browser reported it. A sign-in is only for that site. */
  origin: string;
}

/** What matching a rule needs. Who asked (`origin`) is not part of it: a rule is about the account and what is spent. */
export type RuleMatchContext = Omit<RuleContext, "origin">;

/** The part of a decoded transaction the rules care about. Structurally matches `@repo/protocols`' DecodedAction. */
export interface DecodedForRules {
  protocol: string;
  action: string;
  chainId: number;
  /** The manifest key of the contract called. */
  contract?: string;
  spends: boolean;
  spend: ReadonlyArray<{ token: Address | "native"; amount: bigint; listed?: boolean }>;
  /** A declared minimum to receive. Zero means "accepts nothing in return", which no rule covers. */
  receive?: { minAmount?: bigint };
  /** Any token involved is off the protocol's reviewed list. Never eligible for a rule. */
  unlisted?: boolean;
  /** The protocol's manifest says this must be confirmed every time. Never eligible for a rule. */
  alwaysAsk?: boolean;
  /** Why it always asks, when the general reason does not fit. Shown on the card as written. */
  alwaysAskReason?: string;
}

/** What the confirm card also shows the person. */
export interface DecodedForDisplay extends DecodedForRules {
  receive?: { token: Address | "native"; minAmount?: bigint; listed?: boolean };
  venue?: { pool: Address; band: number };
  /** Plain-text facts a first-party decoder adds: what a launch creates, which route a trade takes. Shown, never matched. */
  details?: ReadonlyArray<{ label: string; value: string }>;
}

export interface DecodedApprovalForRules {
  protocol: string;
  chainId: number;
  token: Address;
  amount: bigint;
  unlimited: boolean;
  /** The manifest key of the contract being given the allowance. */
  spenderKey: string;
  /** False for a token off the protocol's reviewed list: never covered by a rule. */
  listed?: boolean;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function sameToken(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function live(rule: Rule, who: RuleMatchContext): boolean {
  if (!sameToken(rule.account, who.account) || who.now >= rule.expiresAt) return false;
  // A session rule lives only in the session it was made in.
  return rule.persistent || (rule.sessionKey !== null && rule.sessionKey === who.sessionKey);
}

/** The UTC calendar day a daily cap is counted against. */
export function dayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Why a rule may not be saved, or null when it may. Checked in the frame at
 * creation; the scope editor's own validation is a convenience, not the gate.
 */
export function validateRule(rule: Rule, ctx: { now: number; sessionExpiresAt: number | null; chainIds: readonly number[]; spends: boolean }): string | null {
  // Counters are stored under `${id}:${day}` and removed by id prefix, so an id must be one nothing else can prefix.
  if (!UUID.test(rule.id)) return "The rule's id is not valid.";
  if (!ADDRESS.test(rule.account)) return "The rule's account is not a valid address.";
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(rule.protocol)) return "The rule's protocol id is not valid.";
  if (!/^[a-z][a-zA-Z0-9]{0,39}$/.test(rule.action)) return "The rule's action name is not valid.";
  if (!ctx.chainIds.includes(rule.chainId)) return `This wallet does not serve chain ${rule.chainId}.`;
  if (rule.token !== "any" && rule.token !== "native" && !ADDRESS.test(rule.token)) return "The rule's token is not a valid address.";
  if (rule.spenderKey !== undefined && !/^[a-zA-Z][a-zA-Z0-9]{0,39}$/.test(rule.spenderKey)) return "The rule's contract key is not valid.";

  if (rule.token === "any") {
    if (ctx.spends) return "A rule for any token is only allowed for an action that spends nothing. Name the token this action spends.";
    if (rule.maxPerTx !== 0n || rule.maxPerDay !== 0n) return "A rule for any token carries no amounts; both limits must be zero.";
  } else if (ctx.spends) {
    if (rule.maxPerTx <= 0n) return "Set a limit per transaction greater than zero.";
    if (rule.maxPerDay < rule.maxPerTx) return "The limit per day cannot be lower than the limit per transaction.";
    if (rule.maxPerTx > MAX_UINT256 || rule.maxPerDay > MAX_UINT256) return "That limit is too large to be a token amount.";
  } else if (rule.maxPerTx < 0n || rule.maxPerDay < 0n) {
    return "Limits cannot be negative.";
  }

  if (rule.expiresAt <= ctx.now) return "The rule would expire immediately.";
  if (rule.persistent) {
    if (rule.expiresAt > ctx.now + MAX_PERSISTENT_MS) return "A rule that outlives the session can last at most 30 days.";
    if (rule.sessionKey !== null) return "A rule that outlives the session is not tied to one.";
  } else if (ctx.sessionExpiresAt === null || rule.expiresAt > ctx.sessionExpiresAt) {
    return "A rule that ends with the session cannot outlast the session.";
  } else if (rule.sessionKey !== ctx.sessionExpiresAt) {
    return "A rule that ends with the session must belong to the current session.";
  }
  return null;
}

/**
 * The unexpired rules of `account` that cover this action's per-transaction
 * terms, tightest first. The daily cap is NOT checked here: it needs the
 * counter, and the check-and-increment must be one atomic step (`reserveSpend`).
 */
export function matchAction(rules: readonly Rule[], decoded: DecodedForRules, who: RuleMatchContext): Rule[] {
  // A token off the protocol's list is one nobody reviewed: shown to the person, never covered by a rule.
  if (decoded.alwaysAsk) return [];
  if (decoded.unlisted || decoded.spend.some((entry) => entry.listed === false)) return [];
  // "Accepts nothing in return" is how a sandwich is set up. A declared minimum must be real.
  if (decoded.receive?.minAmount !== undefined && decoded.receive.minAmount <= 0n) return [];

  // A rule covers only the contract it was made on: a "swap" drafted on the router, which promises a minimum out,
  // must not cover a swap on another contract that promises none. A rule with no key (made before this check) covers none.
  const base = rules.filter((rule) => live(rule, who) && rule.protocol === decoded.protocol && rule.action === decoded.action && rule.chainId === decoded.chainId && rule.spenderKey !== undefined && rule.spenderKey === decoded.contract);

  if (!decoded.spends) {
    // Declared non-spending yet carrying a spend is a contradiction; never silent.
    return decoded.spend.length === 0 ? base : [];
  }

  // Exactly one spend, in exactly one token. Two tokens cannot be weighed against one cap.
  if (decoded.spend.length !== 1) return [];
  const [spend] = decoded.spend;
  if (!spend || spend.amount <= 0n) return [];

  return base
    .filter((rule) => rule.token !== "any" && sameToken(rule.token, spend.token) && spend.amount <= rule.maxPerTx)
    .sort((a, b) => (a.maxPerDay !== b.maxPerDay ? (a.maxPerDay < b.maxPerDay ? -1 : 1) : a.maxPerTx === b.maxPerTx ? 0 : a.maxPerTx < b.maxPerTx ? -1 : 1));
}

/**
 * Is this ERC-20 approval covered? Only an exact, non-zero approval of a rule's
 * own token to that protocol's router, no larger than the rule lets one
 * transaction spend. It draws nothing from the daily cap: an allowance moves no
 * funds, and the spend it enables is counted when it happens.
 */
export function matchApproval(rules: readonly Rule[], approval: DecodedApprovalForRules, who: RuleMatchContext): boolean {
  if (approval.unlimited || approval.amount <= 0n || approval.listed === false) return false;
  return rules.some(
    (rule) => live(rule, who) && rule.protocol === approval.protocol && rule.chainId === approval.chainId && rule.token !== "any" && rule.token !== "native" && sameToken(rule.token, approval.token) && approval.amount <= rule.maxPerTx &&
      // Only the contract this rule's own action spends through. A rule with no key (made before this check) covers none.
      rule.spenderKey !== undefined && rule.spenderKey === approval.spenderKey,
  );
}
