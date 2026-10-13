import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "./migrate";
import { MIGRATIONS } from "./migrations.generated";
import { ensureUser } from "./auth";
import { createChat, getChat, saveMessages } from "./chats";
import { createTestDb } from "./testing";

describe("embedded migrations", () => {
  it("match the SQL files drizzle-kit generated, so the two cannot drift", () => {
    const journal = JSON.parse(readFileSync(fileURLToPath(new URL("../migrations/meta/_journal.json", import.meta.url)), "utf8")) as { entries: Array<{ tag: string }> };
    expect(MIGRATIONS.map((m) => m.tag)).toEqual(journal.entries.map((e) => e.tag));
    for (const m of MIGRATIONS) expect(m.sql).toBe(readFileSync(fileURLToPath(new URL(`../migrations/${m.tag}.sql`, import.meta.url)), "utf8"));
  });

  it("apply once and are a no-op the second time", async () => {
    const db = await createTestDb(); // already applied once
    expect(await applyMigrations(db)).toEqual([]);
  });

  it("adopt a waitlist table an earlier build created under another tag", async () => {
    // Production was first deployed from the brand branch, which made `waitlist` as `0001_wise_sunset_bain`.
    const db = await createTestDb();
    await db.execute(sql`DELETE FROM app_migrations WHERE tag = '0002_yellow_scarecrow'`);
    await db.execute(sql`INSERT INTO waitlist (email) VALUES ('kept@example.com')`);
    expect(await applyMigrations(db)).toEqual(["0002_yellow_scarecrow"]);
    const rows = await db.execute(sql`SELECT email FROM waitlist`);
    expect(JSON.stringify(rows)).toContain("kept@example.com");
  });

  it("rename a chat saved under the old protocol id, and the tool parts in its history, from iter to rate", async () => {
    const db = await createTestDb();
    const address = "0x0000000000000000000000000000000000001001";
    await ensureUser(db, address);
    const chat = await createChat(db, { address, title: "old", model: "openai/gpt-5.5", protocol: "iter", chainId: 5042002 });
    await saveMessages(db, {
      address,
      chatId: chat.id,
      messages: [
        { id: "u1", role: "user", parts: [{ type: "text", text: 'swap on iter_swap please, the part was "tool-iter_swap" and "toolName": "iter_quote"' }] },
        { id: "a1", role: "assistant", parts: [{ type: "tool-iter_swap", toolCallId: "c1", state: "output-available", input: {}, output: {} }, { type: "dynamic-tool", toolName: "iter_quote", toolCallId: "c2", state: "output-available", input: {}, output: { note: '"tool-iter_swap"' } }] },
      ],
    });
    await db.execute(sql`DELETE FROM app_migrations WHERE tag = '0004_rate_protocol_id'`);
    expect(await applyMigrations(db)).toEqual(["0004_rate_protocol_id"]);

    const read = await getChat(db, { address, chatId: chat.id });
    expect(read?.chat.protocol).toBe("rate");
    expect(read?.messages[1]?.parts).toEqual([
      { type: "tool-rate_swap", toolCallId: "c1", state: "output-available", input: {}, output: {} },
      // Only the tool's own fields change: a tool output that happens to quote the old name is left as it was.
      { type: "dynamic-tool", toolName: "rate_quote", toolCallId: "c2", state: "output-available", input: {}, output: { note: '"tool-iter_swap"' } },
    ]);
    // What the person wrote is theirs: text is never rewritten, even text that spells the old names exactly.
    expect(read?.messages[0]?.parts).toEqual([{ type: "text", text: 'swap on iter_swap please, the part was "tool-iter_swap" and "toolName": "iter_quote"' }]);
  });
});
