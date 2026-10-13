import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./", import.meta.url)) } },
  // Next's tsconfig preserves JSX for its own compiler; component tests need it compiled here.
  esbuild: { jsx: "automatic" },
  test: { include: ["lib/**/*.test.ts", "app/**/*.test.ts", "components/**/*.test.tsx", "proxy.test.ts", "next.config.test.ts"] },
});
