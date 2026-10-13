import { NextResponse } from "next/server";
import { z } from "zod";
import { deleteFolder, FOLDER_NAME_MAX, getDb, renameFolder } from "@repo/db";
import { problem, readJsonBody, sameOrigin } from "@/lib/server/http";
import { folderLimiterByAddress } from "@/lib/server/limits";
import { currentAddress } from "@/lib/server/session";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params) {
  if (!sameOrigin(request)) return problem(403, "FORBIDDEN", "This request did not come from the app.");
  const address = await currentAddress();
  if (!address) return problem(401, "SIGN_IN_REQUIRED", "Sign in first.");
  const limited = folderLimiterByAddress.take(address);
  if (!limited.ok) return problem(429, "RATE_LIMITED", "Too many folder changes. Try again shortly.", { retryAfterSeconds: limited.retryAfterSeconds });
  const body = await readJsonBody(request, 4_096);
  const parsed = z.object({ name: z.string().max(200) }).safeParse(body.ok ? body.value : null);
  if (!parsed.success) return problem(400, "INVALID_REQUEST", `A folder name is 1 to ${FOLDER_NAME_MAX} characters.`);
  const folder = await renameFolder(await getDb(), { address, folderId: (await params).id, name: parsed.data.name });
  return folder ? NextResponse.json({ folder: { id: folder.id, name: folder.name } }) : problem(404, "FOLDER_NOT_FOUND", "That folder does not exist, or the name is empty.");
}

/** Deletes the folder only. Its chats are kept and move out of it. */
export async function DELETE(request: Request, { params }: Params) {
  if (!sameOrigin(request)) return problem(403, "FORBIDDEN", "This request did not come from the app.");
  const address = await currentAddress();
  if (!address) return problem(401, "SIGN_IN_REQUIRED", "Sign in first.");
  const limited = folderLimiterByAddress.take(address);
  if (!limited.ok) return problem(429, "RATE_LIMITED", "Too many folder changes. Try again shortly.", { retryAfterSeconds: limited.retryAfterSeconds });
  const ok = await deleteFolder(await getDb(), { address, folderId: (await params).id });
  return ok ? NextResponse.json({ ok: true }) : problem(404, "FOLDER_NOT_FOUND", "That folder does not exist.");
}
