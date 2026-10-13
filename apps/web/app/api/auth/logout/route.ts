import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { deleteSession, getDb } from "@repo/db";
import { problem, sameOrigin } from "@/lib/server/http";
import { clearCookie, PRE_SESSION_COOKIE, SESSION_COOKIE } from "@/lib/server/session";

export async function POST(request: Request) {
  if (!sameOrigin(request)) return problem(403, "FORBIDDEN", "This request did not come from the app.");
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await deleteSession(await getDb(), token);
  clearCookie(jar, SESSION_COOKIE);
  clearCookie(jar, PRE_SESSION_COOKIE);
  return NextResponse.json({ ok: true });
}
