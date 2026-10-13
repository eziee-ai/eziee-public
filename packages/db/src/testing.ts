import { drizzle } from "drizzle-orm/pglite";
import type { Db } from "./client";
import { applyMigrations } from "./migrate";
import * as schema from "./schema";

export type { Db } from "./client";

/** A fresh in-memory Postgres with the real migrations applied, the same way the app applies them. One per test. */
export async function createTestDb(): Promise<Db> {
  const db = drizzle({ schema }) as unknown as Db;
  await applyMigrations(db);
  return db;
}
