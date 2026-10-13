/**
 * Operator correction of a credit balance (spec §14.1: `adjustment` exists for
 * operator corrections only; there is no free grant and no promo code).
 *
 *   pnpm --filter @repo/db credit:adjust <address> <usd> "<reason>"
 *
 * Writes one idempotent `adjustment` ledger row. On a testnet deployment this is
 * also how a developer gets credit to try the chat before a top-up rail exists.
 */
import { randomUUID } from "node:crypto";
import { getAddress } from "viem";
import { applyCredit, ensureUser, getAccount, getDb } from "../src/index";

const [rawAddress, rawUsd, reason] = process.argv.slice(2);
if (!rawAddress || !rawUsd || !reason) {
  console.error('usage: credit:adjust <address> <usd, e.g. 5 or -1.25> "<reason>"');
  process.exit(2);
}
if (!/^-?\d+(\.\d{1,6})?$/.test(rawUsd)) {
  console.error("usd must be a plain decimal with at most 6 places");
  process.exit(2);
}

const address = getAddress(rawAddress);
const negative = rawUsd.startsWith("-");
const [whole, fraction = ""] = rawUsd.replace("-", "").split(".");
const micro = (BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, "0"))) * (negative ? -1n : 1n);

if (micro === 0n) {
  console.error("an adjustment of zero changes nothing");
  process.exit(2);
}

const db = await getDb();
await ensureUser(db, address);
// Unique per run. A timestamp alone is not: two adjustments in one millisecond would share a ref, and the second would be dropped as a replay.
const ref = `adjustment:${address}:${new Date().toISOString()}:${randomUUID()}`;
const applied = await applyCredit(db, { address, amount: micro, kind: "adjustment", ref, meta: { reason, by: process.env.USER ?? "operator" } });
if (!applied) {
  console.error("the adjustment was NOT applied: its reference already exists");
  process.exit(1);
}
const account = await getAccount(db, address);
console.log(`${address}: balance ${account.balance} micro-USD (${Number(account.balance) / 1e6} USD), spendable ${account.spendable}`);
process.exit(0);
