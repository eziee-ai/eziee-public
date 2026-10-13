import { NextResponse } from "next/server";
import { z } from "zod";
import { deleteChat, getChat, getDb, moveChat, updateChat } from "@repo/db";
import { problem, readJsonBody, sameOrigin } from "@/lib/server/http";
import { currentAddress } from "@/lib/server/session";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const address = await currentAddress();
  if (!address) return problem(401, "SIGN_IN_REQUIRED", "Sign in with your wallet to open a chat.");
  const found = await getChat(await getDb(), { address, chatId: (await params).id });
  if (!found) return problem(404, "CHAT_NOT_FOUND", "That chat does not exist.");
  const { chat, messages } = found;
  return NextResponse.json({ chat: { id: chat.id, title: chat.title, model: chat.model, protocol: chat.protocol, chainId: chat.chainId, folderId: chat.folderId }, messages }, { headers: { "cache-control": "no-store" } });
}

export async function PATCH(request: Request, { params }: Params) {
  if (!sameOrigin(request)) return problem(403, "FORBIDDEN", "This request did not come from the app.");
  const address = await currentAddress();
  if (!address) return problem(401, "SIGN_IN_REQUIRED", "Sign in first.");
  // A title or a folder id: a few hundred bytes. Anything larger is refused unread.
  const read = await readJsonBody(request, 4_096);
  const body: unknown = read.ok ? read.value : null;
  const chatId = (await params).id;
  // Filing a chat: into one of the caller's folders, or out of any (null).
  const move = z.object({ folderId: z.string().max(64).nullable() }).strict().safeParse(body);
  if (move.success) {
    const ok = await moveChat(await getDb(), { address, chatId, folderId: move.data.folderId });
    return ok ? NextResponse.json({ ok: true }) : problem(404, "NOT_FOUND", "That chat or folder does not exist.");
  }
  const parsed = z.object({ title: z.string().trim().min(1).max(80) }).safeParse(body);
  if (!parsed.success) return problem(400, "INVALID_REQUEST", "A title is 1 to 80 characters.");
  const ok = await updateChat(await getDb(), { address, chatId, title: parsed.data.title });
  return ok ? NextResponse.json({ ok: true }) : problem(404, "CHAT_NOT_FOUND", "That chat does not exist.");
}

export async function DELETE(request: Request, { params }: Params) {
  if (!sameOrigin(request)) return problem(403, "FORBIDDEN", "This request did not come from the app.");
  const address = await currentAddress();
  if (!address) return problem(401, "SIGN_IN_REQUIRED", "Sign in first.");
  const ok = await deleteChat(await getDb(), { address, chatId: (await params).id });
  return ok ? NextResponse.json({ ok: true }) : problem(404, "CHAT_NOT_FOUND", "That chat does not exist.");
}
