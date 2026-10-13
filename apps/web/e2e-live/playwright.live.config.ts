import { defineConfig, devices } from "@playwright/test";

/**
 * LIVE run: the real model gateway and Arc testnet, nothing mocked. Credit is free (DEV_FREE_CREDIT), so the only
 * thing a run needs is testnet USDC in the wallet it creates. See live.spec.ts for how to run it.
 */
const PORT = 3300;
export default defineConfig({
  testDir: ".",
  timeout: 45 * 60_000,
  retries: 0,
  use: { baseURL: `http://localhost:${PORT}`, trace: "on", headless: false },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `rm -rf .data/live-pglite && pnpm exec next dev --turbopack --port ${PORT}`,
    cwd: "..",
    env: { PGLITE_DIR: ".data/live-pglite", DEV_FREE_CREDIT: "1" },
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
