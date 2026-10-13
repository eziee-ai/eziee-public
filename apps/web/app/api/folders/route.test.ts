import { beforeEach, describe, expect, it, vi } from "vitest";
import { createChat, ensureUser, getChat, type Db } from "@repo/db";
import { createTestDb } from "@repo/db/testing";

const ALICE = "0x0000000000000000000000000000000000001001";
const BOB = "0x0000000000000000000000000000000000001002";
const who = { address: ALICE as string | null };
let db: Db;

vi.mock("@/lib/server/session", () => ({ currentAddress: async () => who.address }));
vi.mock("@repo/db", async (actual) => ({ ...(await actual<typeof import("@repo/db")>()), getDb: async () => db }));

const folders = await import("./route");
const folder = await import("./[id]/route");
const chats = await import("../chats/route");
const chat = await import("../chats/[id]/route");

const ORIGIN = "http://localhost:3000";
const req = (method: string, body?: unknown, origin = ORIGIN) => new Request(`${ORIGIN}/api/x`, { method, headers: { origin, host: "localhost:3000", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(async () => {
  db = await createTestDb();
  await ensureUser(db, ALICE);
  await ensureUser(db, BOB);
  who.address = ALICE;
});

describe("/api/folders", () => {
  it("creates, lists, renames and deletes a folder; its chat is kept and moved out", async () => {
    const created = await folders.POST(req("POST", { name: "Trading" }));
    expect(created.status).toBe(201);
    const { folder: f } = (await created.json()) as { folder: { id: string; name: string } };
    expect(((await (await folders.GET()).json()) as { folders: unknown[] }).folders).toEqual([expect.objectContaining({ id: f.id, name: "Trading" })]);

    const c = await createChat(db, { address: ALICE, title: "kept", model: "m", protocol: "auto", chainId: 1 });
    expect((await chat.PATCH(req("PATCH", { folderId: f.id }), params(c.id))).status).toBe(200);
    const listed = (await (await chats.GET(new Request(`${ORIGIN}/api/chats`))).json()) as { chats: Array<{ id: string; folderId: string | null }> };
    expect(listed.chats).toEqual([expect.objectContaining({ id: c.id, folderId: f.id })]);

    expect((await folder.PATCH(req("PATCH", { name: "Yield" }), params(f.id))).status).toBe(200);
    expect((await folder.DELETE(req("DELETE"), params(f.id))).status).toBe(200);
    expect((await getChat(db, { address: ALICE, chatId: c.id }))?.chat.folderId).toBeNull();
  });

  it("refuses another origin, a signed-out caller and an empty name", async () => {
    expect((await folders.POST(req("POST", { name: "x" }, "https://evil.example"))).status).toBe(403);
    expect((await folders.POST(req("POST", { name: "   " }))).status).toBe(400);
    who.address = null;
    expect((await folders.POST(req("POST", { name: "x" }))).status).toBe(401);
    expect((await folders.GET()).status).toBe(401);
  });

  it("cannot touch or file into another address's folder", async () => {
    who.address = BOB;
    const { folder: bobs } = (await (await folders.POST(req("POST", { name: "Bob's" }))).json()) as { folder: { id: string } };
    who.address = ALICE;
    const c = await createChat(db, { address: ALICE, title: "mine", model: "m", protocol: "auto", chainId: 1 });
    expect((await chat.PATCH(req("PATCH", { folderId: bobs.id }), params(c.id))).status).toBe(404);
    expect((await folder.PATCH(req("PATCH", { name: "taken" }), params(bobs.id))).status).toBe(404);
    expect((await folder.DELETE(req("DELETE"), params(bobs.id))).status).toBe(404);
  });

  it("renaming a chat still works beside moving one", async () => {
    const c = await createChat(db, { address: ALICE, title: "old", model: "m", protocol: "auto", chainId: 1 });
    expect((await chat.PATCH(req("PATCH", { title: "new" }), params(c.id))).status).toBe(200);
    expect((await getChat(db, { address: ALICE, chatId: c.id }))?.chat.title).toBe("new");
  });
});
