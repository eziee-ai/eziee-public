import { beforeEach, describe, expect, it } from "vitest";
import { ensureUser } from "./auth";
import { createChat, getChat, listChats } from "./chats";
import { createFolder, deleteFolder, FolderLimitError, folderName, listFolders, moveChat, renameFolder } from "./folders";
import { createTestDb, type Db } from "./testing";

const ALICE = "0x0000000000000000000000000000000000001001";
const BOB = "0x0000000000000000000000000000000000001002";
let db: Db;
const chat = (address: string, title = "t") => createChat(db, { address, title, model: "m", protocol: "auto", chainId: 1 });

beforeEach(async () => {
  db = await createTestDb();
  await ensureUser(db, ALICE);
  await ensureUser(db, BOB);
});

describe("folders are scoped to the signed-in address", () => {
  it("creates, lists oldest first, renames and deletes", async () => {
    const a = (await createFolder(db, { address: ALICE, name: "  Trading   ideas " }))!;
    const b = (await createFolder(db, { address: ALICE, name: "Yield" }))!;
    expect(a.name).toBe("Trading ideas");
    expect((await listFolders(db, ALICE)).map((f) => f.name)).toEqual(["Trading ideas", "Yield"]);
    expect((await renameFolder(db, { address: ALICE, folderId: b.id, name: "Liquidity" }))?.name).toBe("Liquidity");
    expect(await deleteFolder(db, { address: ALICE, folderId: a.id })).toBe(true);
    expect((await listFolders(db, ALICE)).map((f) => f.name)).toEqual(["Liquidity"]);
  });

  it("refuses an empty name and cuts a long one to 60 characters", async () => {
    expect(await createFolder(db, { address: ALICE, name: "   " })).toBeNull();
    expect(folderName("x".repeat(80))).toHaveLength(60);
    const f = (await createFolder(db, { address: ALICE, name: "ok" }))!;
    expect(await renameFolder(db, { address: ALICE, folderId: f.id, name: "" })).toBeNull();
  });

  it("another address cannot see, rename or delete it", async () => {
    const f = (await createFolder(db, { address: ALICE, name: "Mine" }))!;
    expect(await listFolders(db, BOB)).toEqual([]);
    expect(await renameFolder(db, { address: BOB, folderId: f.id, name: "Theirs" })).toBeNull();
    expect(await deleteFolder(db, { address: BOB, folderId: f.id })).toBe(false);
    expect((await listFolders(db, ALICE))[0]?.name).toBe("Mine");
  });

  it("a malformed id is simply not found", async () => {
    expect(await renameFolder(db, { address: ALICE, folderId: "nope", name: "x" })).toBeNull();
    expect(await deleteFolder(db, { address: ALICE, folderId: "nope" })).toBe(false);
    expect(await moveChat(db, { address: ALICE, chatId: "nope", folderId: null })).toBe(false);
  });
});

describe("moving a chat", () => {
  it("files a chat into a folder and takes it out again, without bumping it to the top", async () => {
    const f = (await createFolder(db, { address: ALICE, name: "F" }))!;
    const c = await chat(ALICE);
    expect(await moveChat(db, { address: ALICE, chatId: c.id, folderId: f.id })).toBe(true);
    const filed = (await getChat(db, { address: ALICE, chatId: c.id }))!.chat;
    expect(filed.folderId).toBe(f.id);
    expect(filed.updatedAt.getTime()).toBe(c.updatedAt.getTime());
    expect(await moveChat(db, { address: ALICE, chatId: c.id, folderId: null })).toBe(true);
    expect((await getChat(db, { address: ALICE, chatId: c.id }))!.chat.folderId).toBeNull();
  });

  it("never puts a chat into someone else's folder, nor someone else's chat into yours", async () => {
    const bobs = (await createFolder(db, { address: BOB, name: "Bob's" }))!;
    const mine = (await createFolder(db, { address: ALICE, name: "Mine" }))!;
    const c = await chat(ALICE);
    const theirs = await chat(BOB);
    expect(await moveChat(db, { address: ALICE, chatId: c.id, folderId: bobs.id })).toBe(false);
    expect(await moveChat(db, { address: ALICE, chatId: theirs.id, folderId: mine.id })).toBe(false);
    expect((await getChat(db, { address: BOB, chatId: theirs.id }))!.chat.folderId).toBeNull();
  });

  it("deleting a folder keeps its chats, moved out of it", async () => {
    const f = (await createFolder(db, { address: ALICE, name: "F" }))!;
    const c = await chat(ALICE, "kept");
    await moveChat(db, { address: ALICE, chatId: c.id, folderId: f.id });
    await deleteFolder(db, { address: ALICE, folderId: f.id });
    const [left] = await listChats(db, ALICE);
    expect([left?.title, left?.folderId]).toEqual(["kept", null]);
  });

  it("a new chat can be filed on creation, but only into the creator's own folder", async () => {
    const mine = (await createFolder(db, { address: ALICE, name: "Mine" }))!;
    const bobs = (await createFolder(db, { address: BOB, name: "Bob's" }))!;
    expect((await createChat(db, { address: ALICE, title: "a", model: "m", protocol: "auto", chainId: 1, folderId: mine.id })).folderId).toBe(mine.id);
    expect((await createChat(db, { address: ALICE, title: "b", model: "m", protocol: "auto", chainId: 1, folderId: bobs.id })).folderId).toBeNull();
  });
});

describe("the folder cap", () => {
  it("holds even when requests race: the count and the insert are one locked step", async () => {
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => createFolder(db, { address: ALICE, name: `F${i}`, max: 3 })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(results.filter((r) => r.status === "rejected" && r.reason instanceof FolderLimitError)).toHaveLength(3);
    expect(await listFolders(db, ALICE)).toHaveLength(3);
    // Another person's folders are counted on their own.
    expect(await createFolder(db, { address: BOB, name: "Bob's", max: 3 })).not.toBeNull();
  });
});
