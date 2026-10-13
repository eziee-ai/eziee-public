import { defineConfig } from "vitest/config";

// A DOM is opted into per file with `// @vitest-environment jsdom`, as in the
// source repo: pure tests stay fast and a test that forgets the docblock fails loudly.
export default defineConfig({ test: { include: ["src/**/*.test.ts"] } });
