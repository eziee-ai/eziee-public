import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getDb, releaseStaleHolds } from "@repo/db";
import { problem } from "@/lib/server/http";
import { STALE_HOLD_MS } from "@/lib/server/chat";

/**
 * Releases credit holds left behind by requests that never finished, for every account. Each account's own
 * stale holds are already released when it next sends a message; this keeps balances right for accounts that
 * have not come back yet. Meant for a scheduler (Vercel Cron sends `Authorization: Bearer $CRON_SECRET`).
 * Without CRON_SECRET configured the route does not exist.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return new NextResponse(null, { status: 404 });
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return problem(401, "UNAUTHORIZED", "Not allowed.");
  const released = await releaseStaleHolds(await getDb(), new Date(Date.now() - STALE_HOLD_MS));
  return NextResponse.json({ released }, { headers: { "cache-control": "no-store" } });
}
