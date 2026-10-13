import { beforeEach, describe, expect, it } from "vitest";
import { ensureUser } from "./auth";
import { createChat, deleteChat, getChat, listChats, saveMessages, searchChats, updateChat } from "./chats";
import { createTestDb, type Db } from "./testing";

const ALICE = "0x0000000000000000000000000000000000001001";
const BOB = "0x0000000000000000000000000000000000001002";
let db: Db;
const msg = (id: string, role: string, text: string, metadata?: unknown) => ({ id, role, parts: [{ type: "text", text }], metadata });

beforeEach(async () => {
  db = await createTestDb();
  await ensureUser(db, ALICE);
  await ensureUser(db, BOB);
});

describe("chats are scoped to the signed-in address", () => {
  it("creates, lists newest first, and reads back messages in order", async () => {
    const a = await createChat(db, { address: ALICE, title: "Swap 50 USDC to EURC", model: "moonshotai/kimi-k3", protocol: "rate", chainId: 5042002 });
    const b = await createChat(db, { address: ALICE, title: "Open orders", model: "moonshotai/kimi-k3", protocol: "auto", chainId: 5042002 });
    await saveMessages(db, { address: ALICE, chatId: a.id, messages: [msg("m1", "user", "swap"), msg("m2", "assistant", "quote", { costMicrousd: "4200" })] });

    expect((await listChats(db, ALICE)).map((c) => c.id)).toEqual([a.id, b.id]); // saving bumped `a`
    const read = await getChat(db, { address: ALICE, chatId: a.id });
    expect(read?.chat.title).toBe("Swap 50 USDC to EURC");
    expect(read?.messages.map((m) => [m.id, m.role])).toEqual([["m1", "user"], ["m2", "assistant"]]);
    expect(read?.messages[1]?.metadata).toEqual({ costMicrousd: "4200" });
  });

  it("saving again replaces the transcript, so an edited or regenerated reply does not leave a ghost", async () => {
    const chat = await createChat(db, { address: ALICE, title: "t", model: "m", protocol: "auto", chainId: 1 });
    await saveMessages(db, { address: ALICE, chatId: chat.id, messages: [msg("m1", "user", "a"), msg("m2", "assistant", "old")] });
    await saveMessages(db, { address: ALICE, chatId: chat.id, messages: [msg("m1", "user", "a"), msg("m3", "assistant", "new")] });
    expect((await getChat(db, { address: ALICE, chatId: chat.id }))?.messages.map((m) => m.id)).toEqual(["m1", "m3"]);
  });

  it("another address cannot read, write, rename or delete it", async () => {
    const chat = await createChat(db, { address: ALICE, title: "private", model: "m", protocol: "auto", chainId: 1 });
    expect(await getChat(db, { address: BOB, chatId: chat.id })).toBeNull();
    await expect(saveMessages(db, { address: BOB, chatId: chat.id, messages: [msg("x", "user", "hi")] })).rejects.toThrow(/not found/);
    expect(await updateChat(db, { address: BOB, chatId: chat.id, title: "mine now" })).toBe(false);
    expect(await deleteChat(db, { address: BOB, chatId: chat.id })).toBe(false);
    expect(await listChats(db, BOB)).toEqual([]);
    expect((await getChat(db, { address: ALICE, chatId: chat.id }))?.chat.title).toBe("private");
  });

  it("a malformed chat id is 'not found', not a database error", async () => {
    expect(await getChat(db, { address: ALICE, chatId: "not-a-uuid" })).toBeNull();
  });

  it("searches titles without letting the query act as a pattern", async () => {
    await createChat(db, { address: ALICE, title: "Swap 50% of USDC", model: "m", protocol: "auto", chainId: 1 });
    await createChat(db, { address: ALICE, title: "Limit order", model: "m", protocol: "auto", chainId: 1 });
    expect((await searchChats(db, { address: ALICE, query: "swap" })).map((c) => c.title)).toEqual(["Swap 50% of USDC"]);
    expect(await searchChats(db, { address: ALICE, query: "%" })).toHaveLength(1);
    expect(await searchChats(db, { address: ALICE, query: "_" })).toHaveLength(0);
  });

  it("deleting a chat deletes its messages", async () => {
    const chat = await createChat(db, { address: ALICE, title: "t", model: "m", protocol: "auto", chainId: 1 });
    await saveMessages(db, { address: ALICE, chatId: chat.id, messages: [msg("m1", "user", "a")] });
    expect(await deleteChat(db, { address: ALICE, chatId: chat.id })).toBe(true);
    expect(await getChat(db, { address: ALICE, chatId: chat.id })).toBeNull();
  });
});
