import { defineConfig, devices } from "@playwright/test";
import manifest from "../../packages/protocols/registry/rate/manifest.json" with { type: "json" };
import { APP_ORIGIN, APP_PORT, MOCK_CHAIN_PORT, RISE_MOCK_PORT } from "./e2e/ports";

const ARC = 5042002;
const RISE = 11155931;
export { MOCK_CHAIN_PORT };
/** Obviously fake: nothing real is ever sent here. */
export const TREASURY = "0x0000000000000000000000000000000000007001";
/** A made-up token the Arc mock chain answers for, so the tokens page can add one by address. Nothing real. */
export const EXTRA_TOKEN = "0x1111111111111111111111111111111111111111";
const USDC = manifest.tokens[ARC].find((token) => token.symbol === "USDC")!.address;

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: false,
  // The app runs under `next dev`, which compiles a route the first time it is asked for. On a CI runner with a
  // few cores that first compile can outlast a 5 s wait (the wallet frame and /settings/permissions did, on the
  // first run there). A retry meets a compiled route. Playwright reports such a test as FLAKY, so it stays visible,
  // and a test that is really broken still fails every attempt. Locally nothing is retried.
  retries: process.env.CI ? 2 : 0,
  use: { baseURL: APP_ORIGIN, trace: "retain-on-failure" },
  // Chromium only: the virtual authenticator with PRF is a Chrome DevTools Protocol feature.
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    // The SERVER's view of each chain (see e2e/mockChainServer.mjs). The browser's is mocked inside each test.
    // Both app networks are covered, so nothing the server reads in this suite reaches a live testnet.
    { command: "node e2e/mockChainServer.mjs", env: { MOCK_CHAIN_PORT: String(MOCK_CHAIN_PORT), MOCK_CHAIN_ID: String(ARC), MOCK_CHAIN_TOKENS: USDC, MOCK_CHAIN_EXTRA_TOKEN: EXTRA_TOKEN }, url: `http://127.0.0.1:${MOCK_CHAIN_PORT}`, reuseExistingServer: false, timeout: 30_000 },
    { command: "node e2e/mockChainServer.mjs", env: { MOCK_CHAIN_PORT: String(RISE_MOCK_PORT), MOCK_CHAIN_ID: String(RISE) }, url: `http://127.0.0.1:${RISE_MOCK_PORT}`, reuseExistingServer: false, timeout: 30_000 },
    {
      // A fresh database every run.
      command: `rm -rf .data/e2e-pglite && pnpm exec next dev --turbopack --port ${APP_PORT}`,
      env: {
        // A scripted model and test credit, which exist only outside production builds, and a throwaway database.
        E2E_TEST_HOOKS: "1",
        // .env.local is read by this server too; the suite tests real credit, so a developer's free credit stays off.
        DEV_FREE_CREDIT: "",
        // Any signed-in test wallet may open /admin. Ignored unless every test-hook condition holds.
        E2E_ADMIN_ANY: "1",
        PGLITE_DIR: ".data/e2e-pglite",
        // The server reads the mock chain, so the suite needs no live testnet.
        [`RPC_URL_${ARC}`]: `http://127.0.0.1:${MOCK_CHAIN_PORT}`,
        [`RPC_URL_${RISE}`]: `http://127.0.0.1:${RISE_MOCK_PORT}`,
        // The USDC top-up rail, with a throwaway treasury. The token address is Arc's USDC as the Rate manifest names it.
        BILLING_TREASURY_ADDRESS: TREASURY,
        [`BILLING_USDC_${ARC}`]: USDC,
        BILLING_CONFIRMATIONS: "3",
        // Both app networks are testnets, where USDC is free. Said out loud, as an operator would have to.
        BILLING_ALLOW_TESTNET_CREDIT: "1",
      },
      url: APP_ORIGIN,
      // Never reuse: a server started without the test hooks would make the chat tests fail confusingly.
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
