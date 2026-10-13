import { NextResponse } from "next/server";
import { z } from "zod";
import { createFolder, FOLDER_NAME_MAX, FolderLimitError, getDb, listFolders, type Folder } from "@repo/db";
import { problem, readJsonBody, sameOrigin } from "@/lib/server/http";
import { folderLimiterByAddress } from "@/lib/server/limits";
import { currentAddress } from "@/lib/server/session";

/** At most this many folders per person: a sidebar, not a filing cabinet. */
const MAX_FOLDERS = 50;
/** A folder name is at most 60 characters; anything much larger than this is not one. */
const MAX_BODY_BYTES = 4_096;

const folderJson = (f: Folder) => ({ id: f.id, name: f.name, createdAt: f.createdAt.toISOString() });

/** The signed-in wallet's folders, oldest first. */
export async function GET() {
  const address = await currentAddress();
  if (!address) return problem(401, "SIGN_IN_REQUIRED", "Sign in with your wallet to see your folders.");
  const rows = await listFolders(await getDb(), address);
  return NextResponse.json({ folders: rows.map(folderJson) }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return problem(403, "FORBIDDEN", "This request did not come from the app.");
  const address = await currentAddress();
  if (!address) return problem(401, "SIGN_IN_REQUIRED", "Sign in first.");
  const limited = folderLimiterByAddress.take(address);
  if (!limited.ok) return problem(429, "RATE_LIMITED", "Too many folder changes. Try again shortly.", { retryAfterSeconds: limited.retryAfterSeconds });
  const body = await readJsonBody(request, MAX_BODY_BYTES);
  const parsed = z.object({ name: z.string().max(200) }).safeParse(body.ok ? body.value : null);
  if (!parsed.success) return problem(400, "INVALID_REQUEST", `A folder name is 1 to ${FOLDER_NAME_MAX} characters.`);
  const folder = await createFolder(await getDb(), { address, name: parsed.data.name, max: MAX_FOLDERS }).catch((error: unknown) => {
    if (error instanceof FolderLimitError) return "too-many" as const;
    throw error;
  });
  if (folder === "too-many") return problem(409, "TOO_MANY_FOLDERS", `You can have up to ${MAX_FOLDERS} folders.`);
  if (!folder) return problem(400, "INVALID_REQUEST", `A folder name is 1 to ${FOLDER_NAME_MAX} characters.`);
  return NextResponse.json({ folder: folderJson(folder) }, { status: 201 });
}
