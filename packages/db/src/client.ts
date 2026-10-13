import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { applyMigrations } from "./migrate";
import * as schema from "./schema";

/** Either driver, one type: repositories only use what Postgres and PGlite share. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

// Kept on globalThis: a dev server can load this module more than once, and two PGlite instances on one directory corrupt it.
const holder = globalThis as typeof globalThis & { __repoDb?: Promise<Db> | null };

/**
 * The app's database, migrated on first use.
 *
 * `DATABASE_URL` set: Postgres (Neon in production), over postgres.js.
 * Unset: PGlite, a real Postgres compiled to WASM, persisted under `.data/`.
 * That is for local development only, so a fresh checkout runs with no
 * account anywhere; a production build without `DATABASE_URL` is refused.
 */
export function getDb(): Promise<Db> {
  holder.__repoDb ??= connect().catch((error: unknown) => {
    holder.__repoDb = null;
    throw error;
  });
  return holder.__repoDb;
}

async function connect(): Promise<Db> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const [{ drizzle }, { default: postgres }] = await Promise.all([import("drizzle-orm/postgres-js"), import("postgres")]);
    const db = drizzle(postgres(url, { max: 5 }), { schema }) as unknown as Db;
    await applyMigrations(db);
    return db;
  }
  if (process.env.NODE_ENV === "production") throw new Error("DATABASE_URL is not set. The embedded development database is refused in production.");
  const dataDir = process.env.PGLITE_DIR ?? ".data/pglite";
  if (!dataDir.includes("://")) {
    // PGlite creates only the last path segment itself.
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dataDir, { recursive: true });
  }
  const { drizzle } = await import("drizzle-orm/pglite");
  const db = drizzle({ connection: { dataDir }, schema }) as unknown as Db;
  await applyMigrations(db);
  return db;
}
