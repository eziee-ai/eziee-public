import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "./client";
import { chats, folders, messages } from "./schema";

/**
 * Chat history, keyed by wallet address (spec §9). EVERY query here takes the
 * signed-in address and filters by it: a chat id alone opens nothing.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TITLE_MAX = 80;

export interface StoredMessage {
  id: string;
  role: string;
  parts: unknown;
  metadata?: unknown;
}

export type Chat = typeof chats.$inferSelect;

/**
 * A new chat. `folderId` files it straight away, but only into one of the SAME address's folders: anything else is
 * ignored and the chat is created unfiled, never refused, so a stale folder id cannot lose the person's message.
 */
export async function createChat(db: Db, input: { address: string; title: string; model: string; protocol: string; chainId: number; folderId?: string | null }): Promise<Chat> {
  const { folderId, ...rest } = input;
  const owned = folderId && UUID.test(folderId) ? (await db.select({ id: folders.id }).from(folders).where(and(eq(folders.id, folderId), eq(folders.address, input.address)))).length === 1 : false;
  const [row] = await db.insert(chats).values({ ...rest, title: input.title.slice(0, TITLE_MAX), folderId: owned ? folderId! : null }).returning();
  return row!;
}

export function listChats(db: Db, address: string, limit = 50): Promise<Chat[]> {
  return db.select().from(chats).where(eq(chats.address, address)).orderBy(desc(chats.updatedAt), desc(chats.createdAt)).limit(limit);
}

export function searchChats(db: Db, input: { address: string; query: string; limit?: number }): Promise<Chat[]> {
  // The query is matched literally: %, _ and \ are escaped so they cannot act as wildcards.
  const literal = input.query.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  return db
    .select()
    .from(chats)
    .where(and(eq(chats.address, input.address), sql`${chats.title} ILIKE ${`%${literal}%`} ESCAPE '\\'`))
    .orderBy(desc(chats.updatedAt))
    .limit(input.limit ?? 20);
}

export async function getChat(db: Db, input: { address: string; chatId: string }): Promise<{ chat: Chat; messages: StoredMessage[] } | null> {
  if (!UUID.test(input.chatId)) return null;
  const [chat] = await db.select().from(chats).where(and(eq(chats.id, input.chatId), eq(chats.address, input.address)));
  if (!chat) return null;
  const rows = await db.select().from(messages).where(eq(messages.chatId, chat.id)).orderBy(asc(messages.position));
  return { chat, messages: rows.map((m) => ({ id: m.id, role: m.role, parts: m.parts, ...(m.metadata === null ? {} : { metadata: m.metadata }) })) };
}

/** Replace a chat's transcript with `messages`, in one transaction, after proving the chat is the caller's. */
export async function saveMessages(db: Db, input: { address: string; chatId: string; messages: StoredMessage[] }): Promise<void> {
  await db.transaction(async (tx) => {
    const owned = UUID.test(input.chatId) ? await tx.select({ id: chats.id }).from(chats).where(and(eq(chats.id, input.chatId), eq(chats.address, input.address))).for("update") : [];
    if (owned.length === 0) throw new Error("chat not found");
    await tx.delete(messages).where(eq(messages.chatId, input.chatId));
    if (input.messages.length > 0) {
      await tx.insert(messages).values(input.messages.map((m, position) => ({ id: m.id, chatId: input.chatId, position, role: m.role, parts: m.parts, metadata: m.metadata ?? null })));
    }
    await tx.update(chats).set({ updatedAt: new Date() }).where(eq(chats.id, input.chatId));
  });
}

export async function updateChat(db: Db, input: { address: string; chatId: string; title?: string; model?: string; protocol?: string; chainId?: number }): Promise<boolean> {
  if (!UUID.test(input.chatId)) return false;
  const { address, chatId, title, ...rest } = input;
  const rows = await db
    .update(chats)
    .set({ ...rest, ...(title === undefined ? {} : { title: title.slice(0, TITLE_MAX) }), updatedAt: new Date() })
    .where(and(eq(chats.id, chatId), eq(chats.address, address)))
    .returning({ id: chats.id });
  return rows.length === 1;
}

export async function deleteChat(db: Db, input: { address: string; chatId: string }): Promise<boolean> {
  if (!UUID.test(input.chatId)) return false;
  const rows = await db.delete(chats).where(and(eq(chats.id, input.chatId), eq(chats.address, input.address))).returning({ id: chats.id });
  return rows.length === 1;
}
