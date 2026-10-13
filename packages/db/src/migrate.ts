import { sql } from "drizzle-orm";
import type { Db } from "./client";
import { MIGRATIONS } from "./migrations.generated";

/**
 * Applies the embedded migrations, in order, each in its own transaction, once.
 * Drizzle's own migrator reads a folder; this reads a module, so it works inside
 * a bundle. A Postgres advisory lock keeps two starting instances from racing.
 */
const LOCK_KEY = 7_226_415; // arbitrary, fixed: the id of "this app is migrating"

export async function applyMigrations(db: Db): Promise<string[]> {
  const applied: string[] = [];
  await db.execute(sql`CREATE TABLE IF NOT EXISTS app_migrations (tag text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  for (const migration of MIGRATIONS) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${LOCK_KEY})`);
      const done = await tx.execute(sql`SELECT 1 FROM app_migrations WHERE tag = ${migration.tag}`);
      if ((done as unknown as { rows?: unknown[] }).rows?.length ?? (done as unknown as unknown[]).length) return;
      for (const statement of migration.sql.split("--> statement-breakpoint")) if (statement.trim()) await tx.execute(sql.raw(statement));
      await tx.execute(sql`INSERT INTO app_migrations (tag) VALUES (${migration.tag})`);
      applied.push(migration.tag);
    });
  }
  return applied;
}
