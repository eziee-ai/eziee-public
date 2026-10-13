import { NextResponse } from "next/server";
import { getDb, listChats, searchChats } from "@repo/db";
import { problem } from "@/lib/server/http";
import { currentAddress } from "@/lib/server/session";

/** The signed-in wallet's chats, newest first; `?q=` searches titles. */
export async function GET(request: Request) {
  const address = await currentAddress();
  if (!address) return problem(401, "SIGN_IN_REQUIRED", "Sign in with your wallet to see your chats.");
  const query = new URL(request.url).searchParams.get("q")?.trim().slice(0, 80) ?? "";
  const db = await getDb();
  const rows = query ? await searchChats(db, { address, query }) : await listChats(db, address, 200);
  return NextResponse.json({ chats: rows.map((c) => ({ id: c.id, title: c.title, model: c.model, protocol: c.protocol, chainId: c.chainId, folderId: c.folderId, updatedAt: c.updatedAt.toISOString() })) }, { headers: { "cache-control": "no-store" } });
}
