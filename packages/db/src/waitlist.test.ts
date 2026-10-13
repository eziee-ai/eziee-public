import { expect, it } from "vitest";
import { createTestDb } from "./testing";
import { joinWaitlist } from "./waitlist";
import { waitlist } from "./schema";

it("persists a timestamped email and deduplicates normalized concurrent requests", async () => {
  const db = await createTestDb();
  await Promise.all([joinWaitlist(db, " Alice@Example.com "), joinWaitlist(db, "alice@example.com")]);
  const rows = await db.select().from(waitlist);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.email).toBe("alice@example.com");
  expect(rows[0]?.createdAt).toBeInstanceOf(Date);
});
