import { and, asc, count, eq } from "drizzle-orm";
import type { Db } from "./client";
import { chats, folders, users } from "./schema";

/**
 * Folders group a person's chats, like ChatGPT projects. Every query takes the signed-in address and filters by it,
 * and a chat only ever goes into a folder of the SAME address: a folder id alone opens or fills nothing.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const FOLDER_NAME_MAX = 60;

export type Folder = typeof folders.$inferSelect;

/** A usable folder name: trimmed, inner whitespace collapsed, 1 to 60 characters. Null when nothing is left. */
export function folderName(raw: string): string | null {
  const name = raw.replace(/\s+/g, " ").trim().slice(0, FOLDER_NAME_MAX);
  return name.length > 0 ? name : null;
}

/** Thrown by `createFolder` when the owner already has `max` folders. */
export class FolderLimitError extends Error {
  constructor(readonly max: number) {
    super(`at most ${max} folders`);
  }
}

/**
 * A new folder, or null for an empty name. With `max`, the count and the insert happen under a lock on the owner's
 * row, so parallel requests cannot pass the cap; past it, `FolderLimitError` is thrown.
 */
export async function createFolder(db: Db, input: { address: string; name: string; max?: number }): Promise<Folder | null> {
  const name = folderName(input.name);
  if (!name) return null;
  return db.transaction(async (tx) => {
    if (input.max !== undefined) {
      await tx.select({ address: users.address }).from(users).where(eq(users.address, input.address)).for("update");
      const [{ n } = { n: 0 }] = await tx.select({ n: count() }).from(folders).where(eq(folders.address, input.address));
      if (n >= input.max) throw new FolderLimitError(input.max);
    }
    const [row] = await tx.insert(folders).values({ address: input.address, name }).returning();
    return row!;
  });
}

/** Oldest first, so a folder keeps its place in the sidebar. */
export function listFolders(db: Db, address: string): Promise<Folder[]> {
  return db.select().from(folders).where(eq(folders.address, address)).orderBy(asc(folders.createdAt), asc(folders.id));
}

export async function renameFolder(db: Db, input: { address: string; folderId: string; name: string }): Promise<Folder | null> {
  const name = folderName(input.name);
  if (!name || !UUID.test(input.folderId)) return null;
  const [row] = await db
    .update(folders)
    .set({ name, updatedAt: new Date() })
    .where(and(eq(folders.id, input.folderId), eq(folders.address, input.address)))
    .returning();
  return row ?? null;
}

/** Deletes the folder. Its chats are kept and move out of it (the foreign key sets their folder to null). */
export async function deleteFolder(db: Db, input: { address: string; folderId: string }): Promise<boolean> {
  if (!UUID.test(input.folderId)) return false;
  const rows = await db.delete(folders).where(and(eq(folders.id, input.folderId), eq(folders.address, input.address))).returning({ id: folders.id });
  return rows.length === 1;
}

/**
 * Puts one of the caller's chats into one of the caller's folders, or takes it out (`folderId: null`). False when
 * either is not the caller's. Does not touch `updatedAt`: filing a chat is not activity in it.
 */
export async function moveChat(db: Db, input: { address: string; chatId: string; folderId: string | null }): Promise<boolean> {
  if (!UUID.test(input.chatId) || (input.folderId !== null && !UUID.test(input.folderId))) return false;
  return db.transaction(async (tx) => {
    if (input.folderId !== null) {
      const owned = await tx.select({ id: folders.id }).from(folders).where(and(eq(folders.id, input.folderId), eq(folders.address, input.address))).for("update");
      if (owned.length === 0) return false;
    }
    const rows = await tx
      .update(chats)
      .set({ folderId: input.folderId })
      .where(and(eq(chats.id, input.chatId), eq(chats.address, input.address)))
      .returning({ id: chats.id });
    return rows.length === 1;
  });
}
