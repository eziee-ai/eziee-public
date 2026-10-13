import { defineConfig } from "drizzle-kit";

// Only `generate` is used: it turns src/schema.ts into SQL files under ./migrations,
// which are applied at startup by src/client.ts. No database connection is needed to generate.
export default defineConfig({ dialect: "postgresql", schema: "./src/schema.ts", out: "./migrations" });
