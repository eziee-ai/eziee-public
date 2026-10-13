import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const waitlist = pgTable("waitlist", {
  email: text("email").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Everything the server stores (spec §9, §14.1). Every row that belongs to a
 * person is keyed by their wallet ADDRESS, stored checksummed. Permission rules
 * are deliberately NOT here: they live in the wallet frame, per device (D4).
 *
 * Money is integer micro-USD (1 USD = 1_000_000) in `bigint` columns. No floats.
 */

export const users = pgTable("users", {
  address: text("address").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Sign-in nonces: single use, five minutes, bound to the browser that asked for one. */
export const authNonces = pgTable(
  "auth_nonces",
  {
    nonce: text("nonce").primaryKey(),
    /** SHA-256 of the requesting browser's pre-session cookie. A nonce is only good in that browser. */
    binding: text("binding").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  // Expired rows are pruned on every sign-in; without this that is a scan of the whole table on the hot path.
  (t) => [index("auth_nonces_expires_idx").on(t.expiresAt)],
);

export const sessions = pgTable(
  "sessions",
  {
    /** SHA-256 of the session token. The token itself is only ever in the user's cookie. */
    id: text("id").primaryKey(),
    address: text("address").notNull().references(() => users.address, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sessions_address_idx").on(t.address), index("sessions_expires_idx").on(t.expiresAt)],
);

/** A person's named group of chats, like a ChatGPT project. Deleting one keeps its chats: they move out of it. */
export const folders = pgTable(
  "folders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    address: text("address").notNull().references(() => users.address, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("folders_address_idx").on(t.address, t.createdAt)],
);

export const chats = pgTable(
  "chats",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    address: text("address").notNull().references(() => users.address, { onDelete: "cascade" }),
    /** The folder it sits in, or null. Always one of the SAME address's folders: enforced where it is set (folders.ts). */
    folderId: uuid("folder_id").references(() => folders.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    model: text("model").notNull(),
    /** "auto" or a protocol id: which adapters' tools the model is given (spec D12). */
    protocol: text("protocol").notNull().default("auto"),
    chainId: integer("chain_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("chats_address_updated_idx").on(t.address, t.updatedAt)],
);

export const messages = pgTable(
  "messages",
  {
    /** The AI SDK's message id, unique within a chat. */
    id: text("id").notNull(),
    chatId: uuid("chat_id").notNull().references(() => chats.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    role: text("role").notNull(),
    parts: jsonb("parts").notNull(),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.chatId, t.id] }), index("messages_chat_position_idx").on(t.chatId, t.position)],
);

export const creditAccounts = pgTable(
  "credit_accounts",
  {
    address: text("address").primaryKey().references(() => users.address, { onDelete: "cascade" }),
    balanceMicrousd: bigint("balance_microusd", { mode: "bigint" }).notNull().default(sql`0`),
    heldMicrousd: bigint("held_microusd", { mode: "bigint" }).notNull().default(sql`0`),
    blocked: boolean("blocked").notNull().default(false),
  },
  // INVARIANT: held never exceeds balance, and a hold is never negative. Enforced by the database, not by hope.
  (t) => [check("credit_held_within_balance", sql`${t.heldMicrousd} >= 0 AND ${t.heldMicrousd} <= GREATEST(${t.balanceMicrousd}, 0)`)],
);

/** Append-only. INVARIANT: an account's balance equals the sum of its ledger deltas. */
export const creditLedger = pgTable(
  "credit_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    address: text("address").notNull().references(() => users.address, { onDelete: "cascade" }),
    deltaMicrousd: bigint("delta_microusd", { mode: "bigint" }).notNull(),
    /** topup_usdc | topup_card | topup_token | usage | refund | adjustment */
    kind: text("kind").notNull(),
    /** What makes a credit idempotent: `<chainId>:<txHash>:<logIndex>`, a Stripe event id, a request id. */
    ref: text("ref").notNull().unique(),
    test: boolean("test").notNull().default(false),
    meta: jsonb("meta"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("credit_ledger_address_idx").on(t.address, t.createdAt)],
);

/** One row per metered request in flight, so a crashed request's hold can be found and released. */
export const creditHolds = pgTable(
  "credit_holds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    address: text("address").notNull().references(() => users.address, { onDelete: "cascade" }),
    amountMicrousd: bigint("amount_microusd", { mode: "bigint" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
  },
  // The second serves the scheduled sweep of stale holds across all accounts, which has no address to lead with.
  (t) => [index("credit_holds_open_idx").on(t.address, t.releasedAt), index("credit_holds_stale_idx").on(t.releasedAt, t.createdAt)],
);

/**
 * Tokens other than USDC that buy credit, set by an operator on /admin. The price is FIXED, in micro-USD of credit
 * per one whole token: these are the app's own test tokens, which have no market to price them. Symbol and decimals
 * are what the chain said when the token was added, never what the operator typed.
 */
export const paymentTokens = pgTable(
  "payment_tokens",
  {
    chainId: integer("chain_id").notNull(),
    /** Checksummed. */
    address: text("address").notNull(),
    symbol: text("symbol").notNull(),
    decimals: integer("decimals").notNull(),
    microusdPerToken: bigint("microusd_per_token", { mode: "bigint" }).notNull(),
    enabled: boolean("enabled").notNull().default(true),
    /** The contract has an open `claim()` faucet the page may offer. */
    faucet: boolean("faucet").notNull().default(false),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.chainId, t.address] }), check("payment_token_price_positive", sql`${t.microusdPerToken} > 0`)],
);
