import { expect, test, type Page } from "@playwright/test";
import { dismissOnboardingWhenItBlocks } from "./onboarding";

async function addPasskeyAuthenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true },
  });
  await dismissOnboardingWhenItBlocks(page);
}

const rules = (page: Page) => page.frameLocator('[data-testid="wallet-rules-frame"]');

test("Permissions shows the wallet's own rule list: locked before connecting, empty after", async ({ page }) => {
  await addPasskeyAuthenticator(page);
  await page.goto("/settings/permissions");
  await expect(page.getByRole("heading", { name: "Permissions" })).toBeVisible();
  await expect(page.getByText("These always ask, whatever rules exist")).toBeVisible();
  await expect(rules(page).getByTestId("rules-locked")).toBeVisible();

  await page.goto("/deposit");
  await page.getByTestId("connect-button").click();
  await expect(page.getByTestId("wallet-address")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("link", { name: "Permissions" }).click();
  await expect(rules(page).getByTestId("rules-empty")).toBeVisible();
});

test("ending the session from the wallet's rule list locks the wallet", async ({ page }) => {
  await addPasskeyAuthenticator(page);
  await page.goto("/deposit");
  await page.getByTestId("connect-button").click();
  await expect(page.getByTestId("wallet-address")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("link", { name: "Permissions" }).click();
  await rules(page).getByTestId("rules-end-session").click();
  await expect(rules(page).getByTestId("rules-locked")).toBeVisible();
});
