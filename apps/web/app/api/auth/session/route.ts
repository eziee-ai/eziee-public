import { NextResponse } from "next/server";
import { getAccount, getDb } from "@repo/db";
import { isAdmin } from "@/lib/server/admin";
import { minHoldMicrousd } from "@/lib/server/billing/config";
import { defaultSendFloor } from "@/lib/server/billing/sendFloor";
import { currentAddress } from "@/lib/server/session";
import { refillFreeCredit } from "@/lib/server/testHooks";

/**
 * Who is signed in, how much credit they can spend, how much is held for replies in flight, the least a message
 * holds, and what one send of the default model needs. Micro-USD travels as a string: it is a bigint. The last two
 * serve an estimate only, so either is left out when it cannot be had, and the answer still comes.
 */
export async function GET() {
  const address = await currentAddress();
  if (!address) return NextResponse.json({ address: null }, { headers: { "cache-control": "no-store" } });
  const db = await getDb();
  await refillFreeCredit(db, address);
  const [account, floor] = await Promise.all([getAccount(db, address), defaultSendFloor()]);
  return NextResponse.json({ address, admin: isAdmin(address), credit: { spendableMicrousd: account.spendable.toString(), heldMicrousd: account.held.toString(), ...readable("minHoldMicrousd", minHoldMicrousd), ...(floor !== null ? { sendFloorMicrousd: floor.toString() } : {}), blocked: account.blocked } }, { headers: { "cache-control": "no-store" } });
}

/** A billing number the browser uses for estimates only. One that cannot be read is left out, and sign-in still answers. */
function readable(key: string, read: () => bigint): Record<string, string> {
  try {
    return { [key]: read().toString() };
  } catch (error) {
    console.error(`[session] ${key} could not be read`, error instanceof Error ? error.message : error);
    return {};
  }
}
