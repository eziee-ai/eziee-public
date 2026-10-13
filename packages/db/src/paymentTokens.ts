import { and, asc, eq } from "drizzle-orm";
import type { Db } from "./client";
import { paymentTokens } from "./schema";

export type PaymentToken = typeof paymentTokens.$inferSelect;

/** Every configured token, or only those that may be paid with now. */
export async function listPaymentTokens(db: Db, options: { enabledOnly?: boolean } = {}): Promise<PaymentToken[]> {
  const query = db.select().from(paymentTokens);
  const rows = await (options.enabledOnly ? query.where(eq(paymentTokens.enabled, true)) : query).orderBy(asc(paymentTokens.chainId), asc(paymentTokens.symbol));
  return rows;
}

/** One enabled token, by chain and (checksummed) address. */
export async function getPaymentToken(db: Db, chainId: number, address: string): Promise<PaymentToken | null> {
  const [row] = await db
    .select()
    .from(paymentTokens)
    .where(and(eq(paymentTokens.chainId, chainId), eq(paymentTokens.address, address), eq(paymentTokens.enabled, true)));
  return row ?? null;
}

/** Adds a token, or changes the price and switches of one already there. */
export async function savePaymentToken(db: Db, token: Omit<PaymentToken, "updatedAt">): Promise<PaymentToken> {
  const [row] = await db
    .insert(paymentTokens)
    .values(token)
    .onConflictDoUpdate({
      target: [paymentTokens.chainId, paymentTokens.address],
      set: { symbol: token.symbol, decimals: token.decimals, microusdPerToken: token.microusdPerToken, enabled: token.enabled, faucet: token.faucet, updatedBy: token.updatedBy, updatedAt: new Date() },
    })
    .returning();
  return row!;
}
