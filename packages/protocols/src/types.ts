import type { Address, Chain, Hex, PublicClient } from "viem";
import type { z } from "zod";

/** `canonical`: the chain's own asset or its issuer's deployment. `listed`: on the protocol's list. */
export type TokenTrust = "canonical" | "listed";

export interface Token {
  chainId: number;
  address: Address;
  symbol: string;
  name: string;
  /** Read onchain by consumers before any money math; this value is the manifest's claim. */
  decimals: number;
  trust: TokenTrust;
}

/** A transaction as an adapter builds it and as the wallet frame receives it. */
export interface TxRequest {
  chainId: number;
  to: Address;
  data: Hex;
  /** Wei of the chain's native asset. */
  value: bigint;
}

export interface Spend {
  /** `"native"` is the chain's gas asset. */
  token: Address | "native";
  /** Base units of `token`. */
  amount: bigint;
  /** On the protocol's reviewed token list (native always is). */
  listed: boolean;
}

/** What a transaction does, derived from calldata and a manifest alone. */
export interface DecodedAction {
  protocol: string;
  action: string;
  chainId: number;
  /** The manifest key of the contract called, e.g. `"router"`. */
  contract: string;
  spends: boolean;
  spend: Spend[];
  receive?: { token: Address | "native"; minAmount?: bigint; listed: boolean };
  /**
   * True when any token involved is NOT on the protocol's reviewed list (a freshly launched
   * coin, say). The action is still described, so a person can weigh it, but it is never
   * eligible for a rule, and a card must show such a token by address, not by a symbol
   * anyone could have given it.
   */
  unlisted: boolean;
  recipient?: Address;
  deadline?: bigint;
  /** Where, for an action that names a venue the person should see: which pool, and which of its price bands. */
  venue?: { pool: Address; band: number };
  /**
   * The manifest says this action must be confirmed every time, because it can give something up that no spend
   * amount describes (withdrawing liquidity early forfeits fees). Never eligible for a rule.
   */
  alwaysAsk?: true;
  /** Why it always asks, in the wallet's words, when the general reason (fees a withdrawal forfeits) does not fit. */
  alwaysAskReason?: string;
  /**
   * Extra facts for the wallet card, as label/value text: what a launch creates, which route a trade takes. Plain
   * text a first-party decoder wrote from the calldata; never used by rules, only shown.
   */
  details?: ReadonlyArray<{ label: string; value: string }>;
}

export interface DecodedApproval {
  protocol: string;
  chainId: number;
  token: Address;
  spender: Address;
  /** The manifest key of the spender contract. Only `router`-role contracts are ever reported. */
  spenderKey: string;
  amount: bigint;
  /** `amount == 2^256 - 1`. Callers refuse these (spec §6.1: exact approvals only). */
  unlimited: boolean;
  /** False for a token off the reviewed list (a launch coin): shown by address, and never covered by a rule. */
  listed?: boolean;
}

export interface SimResult {
  ok: boolean;
  gas?: bigint;
  /** Decoded revert reason when `ok` is false and one was available. */
  reason?: string;
  /** Indexes that could not be simulated yet because an approval earlier in the batch is not mined. Re-simulate them after it is. */
  deferred?: number[];
}

export interface AdapterContext {
  chainId: number;
  /** The user's address. Reads that are not per-user ignore it. */
  account?: Address;
  client: PublicClient;
}

export interface AdapterAction<I = unknown> {
  /** Written for a language model: what this does, what each amount means, what to do first. */
  description: string;
  /** Parses untrusted input (a model's tool call) into `I`. */
  intent: z.ZodType<I, z.ZodTypeDef, unknown>;
  /**
   * A JSON Schema for the intent, when the adapter has one and no zod schema that says as much (an MCP
   * protocol's intents are described by its server). It only tells the MODEL what to send. It is never
   * what makes a transaction acceptable: the manifest decode of what `build` returns is.
   */
  intentJsonSchema?: Record<string, unknown>;
  /** Deterministic. Includes an exact-amount approve when one is needed. */
  build(intent: I, ctx: AdapterContext & { account: Address }): Promise<TxRequest[]>;
  simulate(txs: TxRequest[], ctx: AdapterContext & { account: Address }): Promise<SimResult>;
  /**
   * When the transactions `build` returned stop being good, in ms since the epoch, if the builder said. A quote from a
   * protocol's server is priced for a moment; the caller checks this again right before each transaction is sent.
   */
  expiresAt?(txs: TxRequest[]): number | undefined;
  /**
   * What the action actually did, read from the last transaction's receipt logs. A transaction can succeed and move
   * nothing (a market order that matched nothing refunds and still succeeds), so success alone is not "done".
   * `filled: false` is reported to the person and the model as exactly that.
   */
  outcome?(intent: I, logs: readonly ReceiptLog[], ctx: AdapterContext & { account: Address }): Promise<ActionOutcome>;
}

/** One log of a mined transaction, as a receipt carries it. */
export interface ReceiptLog {
  address: Address;
  topics: readonly Hex[];
  data: Hex;
}

/** What a confirmed action really did. `facts` are short labelled values worth showing (a new coin's address). */
export interface ActionOutcome {
  filled: boolean;
  message: string;
  facts?: Record<string, string>;
}

export interface AdapterRead<I = unknown, O = unknown> {
  /** Written for a language model. */
  description: string;
  /** Parses untrusted input (a model's tool call) into `I`, applying defaults. */
  input: z.ZodType<I, z.ZodTypeDef, unknown>;
  /** As `AdapterAction.intentJsonSchema`, for a read's input. */
  inputJsonSchema?: Record<string, unknown>;
  run(input: I, ctx: AdapterContext): Promise<O>;
}

/** The one seam the chat, agent and wallet layers know (spec §6). */
export interface ProtocolAdapter {
  id: string;
  chains: readonly Chain[];
  contracts(chainId: number): Record<string, Address>;
  tokens(chainId: number): Token[];
  // Heterogeneous by design: each entry fixes its own intent and result types.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  actions: Record<string, AdapterAction<any>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reads: Record<string, AdapterRead<any, any>>;
  /** Pure: no network. Used by the wallet frame. */
  decode(chainId: number, tx: TxRequest, signer: Address): DecodedAction | null;
  /**
   * First-party adapters only (guideline §4): actions that cannot be declared in a manifest
   * because calldata alone does not say what they do. May read the chain. Null on any doubt.
   */
  decodeWithChain?(tx: TxRequest, signer: Address, client: PublicClient): Promise<DecodedAction | null>;
}

/**
 * The measures a protocol's optional `rank` read can order its markets by. Shared so the agent can name a measure
 * without knowing any one protocol. A `rank` read takes `{ measure, limit }`.
 */
export const RANK_MEASURES = ["highest_yield", "deepest_liquidity", "most_traded", "weekly_momentum", "monthly_dip", "lowest_risk"] as const;
export type RankMeasure = (typeof RANK_MEASURES)[number];
