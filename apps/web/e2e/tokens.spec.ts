import { expect, test, type Page } from "@playwright/test";
import { getAddress } from "viem";
import { EXTRA_TOKEN } from "../playwright.config";
import { mockRpc } from "./rpcMock";
import { dismissOnboardingWhenItBlocks } from "./onboarding";
import { startOnArc } from "./startOnArc";

// Arc's USDC and EURC, as vendored in @repo/protocols (registry/rate/manifest.json).
const USDC = "0x3600000000000000000000000000000000000000";
const EURC = "0x89b50855aa3be2f677cd6303cec089b5f319d72a";
// A second made-up token that gives itself USDC's symbol. It exists only in this browser mock.
const LOOKALIKE = "0x2222222222222222222222222222222222222222";
// An address with no code on the mock chain.
const EMPTY = "0x0000000000000000000000000000000000001234";
const RECIPIENT = "0x0000000000000000000000000000000000001234";

async function addPasskeyAuthenticator(page: Page) {
  await startOnArc(page);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true },
  });
  await dismissOnboardingWhenItBlocks(page);
}

function funded(page: Page) {
  return mockRpc(page.context(), {
    nativeBalance: 100n * 10n ** 18n,
    tokenBalances: { [USDC]: 100_000_000n, [EURC]: 0n, [EXTRA_TOKEN]: 5_000_000n, [LOOKALIKE]: 3_000_000n },
    tokenMeta: { [USDC]: { symbol: "USDC", decimals: 6 }, [EURC]: { symbol: "EURC", decimals: 6 }, [EXTRA_TOKEN]: { symbol: "TEST", name: "Test Token", decimals: 6 }, [LOOKALIKE]: { symbol: "USDC", name: "Not USD Coin", decimals: 6 } },
  });
}

const rows = (page: Page) => page.getByTestId("tokens-list").locator('[data-testid^="token-row-"]');

test("lists, pins, hides and adds wallet tokens, and the withdraw page offers the added one", async ({ page }) => {
  await addPasskeyAuthenticator(page);
  await funded(page);
  await page.goto("/tokens");
  await page.getByTestId("tokens-connect").click();

  await expect(page.getByTestId(`token-row-${USDC}`)).toContainText("100", { timeout: 30_000 });
  await expect(rows(page).first()).toHaveAttribute("data-testid", `token-row-${USDC}`);

  // Pinning moves a row to the top, and the pin survives a reload.
  await page.getByTestId(`pin-${EURC}`).click();
  await expect(page.getByTestId(`pin-${EURC}`)).toHaveAttribute("aria-pressed", "true");
  await expect(rows(page).first()).toHaveAttribute("data-testid", `token-row-${EURC}`);
  await page.reload();
  await expect(page.getByTestId(`pin-${EURC}`)).toHaveAttribute("aria-pressed", "true", { timeout: 30_000 });
  await expect(rows(page).first()).toHaveAttribute("data-testid", `token-row-${EURC}`);

  // Hiding moves a row out of the list, under Hidden.
  await page.getByTestId(`hide-${USDC}`).click();
  await expect(page.getByTestId("tokens-list").getByTestId(`token-row-${USDC}`)).toHaveCount(0);
  await expect(page.getByTestId("tokens-hidden-toggle")).toHaveText(/Hidden \(1\)/);
  await page.getByTestId("tokens-hidden-toggle").click();
  await expect(page.getByTestId("tokens-hidden").getByTestId(`token-row-${USDC}`)).toBeVisible();

  // An address with no code is refused by name.
  await page.getByTestId("add-token-address").fill(EMPTY);
  await page.getByTestId("add-token-check").click();
  await expect(page.getByTestId("add-token-result")).toContainText("Not a contract on Arc Testnet");

  // A real (mock) token is read from the chain and offered as unreviewed.
  await page.getByTestId("add-token-address").fill(EXTRA_TOKEN);
  await page.getByTestId("add-token-check").click();
  const card = page.getByTestId("add-token-result");
  await expect(card).toContainText("TEST");
  await expect(card).toContainText("Test Token");
  await expect(card).toContainText("6");
  await expect(card).toContainText("The assistant will not trade it.");
  await page.getByTestId("add-token-add").click();

  const added = page.getByTestId(`token-row-${EXTRA_TOKEN}`);
  await expect(added).toContainText("Unreviewed");
  await expect(added).toContainText("5");

  // The withdraw page lists it too, with the same label.
  await page.goto("/withdraw");
  await page.getByTestId("asset-USDC").or(page.getByTestId("withdraw-connect")).first().waitFor();
  if (await page.getByTestId("withdraw-connect").isVisible()) await page.getByTestId("withdraw-connect").click();
  await expect(page.getByTestId("asset-TEST")).toContainText("Unreviewed", { timeout: 30_000 });
  await expect(page.getByTestId("asset-TEST")).toContainText("5");
});

async function addToken(page: Page, address: string) {
  await page.getByTestId("add-token-address").fill(address);
  await page.getByTestId("add-token-check").click();
  await page.getByTestId("add-token-add").click();
  await expect(page.getByTestId(`token-row-${address}`)).toBeVisible({ timeout: 30_000 });
}

test("a token whose balance stops reading shows as unavailable, the others stay, and it can still be removed", async ({ page }) => {
  await addPasskeyAuthenticator(page);
  const rpc = await funded(page);
  await page.goto("/tokens");
  await page.getByTestId("tokens-connect").click();
  await expect(page.getByTestId(`token-row-${USDC}`)).toContainText("100", { timeout: 30_000 });
  await addToken(page, EXTRA_TOKEN);
  await addToken(page, LOOKALIKE);

  // The token breaks after it was added.
  rpc.revertBalanceOf.add(EXTRA_TOKEN);
  await page.reload();
  const broken = page.getByTestId(`token-row-${EXTRA_TOKEN}`);
  await expect(broken).toContainText("Balance unavailable", { timeout: 30_000 });
  await expect(broken).not.toContainText("0");
  await expect(page.getByTestId(`token-row-${LOOKALIKE}`)).toContainText("3");

  await page.getByTestId(`remove-${EXTRA_TOKEN}`).click();
  await expect(broken).toHaveCount(0);
  await expect(page.getByTestId(`token-row-${LOOKALIKE}`)).toBeVisible();
});

test("an unreviewed token that calls itself USDC is labelled at confirm time, with its contract and a warning", async ({ page }) => {
  await addPasskeyAuthenticator(page);
  await funded(page);
  await page.goto("/tokens");
  await page.getByTestId("tokens-connect").click();
  await expect(page.getByTestId(`token-row-${USDC}`)).toContainText("100", { timeout: 30_000 });
  await addToken(page, LOOKALIKE);

  await page.goto("/withdraw");
  await page.getByTestId("asset-USDC").or(page.getByTestId("withdraw-connect")).first().waitFor();
  if (await page.getByTestId("withdraw-connect").isVisible()) await page.getByTestId("withdraw-connect").click();
  const lookalike = page.getByTestId("asset-USDC").filter({ hasText: "Unreviewed" });
  await expect(lookalike).toBeVisible({ timeout: 30_000 });
  await lookalike.click();
  await page.getByTestId("withdraw-amount").fill("1");
  await page.getByTestId("withdraw-recipient").fill(RECIPIENT);
  await page.getByTestId("withdraw-preview").click();

  await expect(page.getByTestId("withdraw-preview-amount")).toHaveText("1 USDC");
  const card = page.locator("section").filter({ has: page.getByTestId("withdraw-preview-amount") });
  await expect(card.getByText("Unreviewed", { exact: true })).toBeVisible();
  await expect(page.getByTestId("withdraw-preview-contract")).toHaveText(getAddress(LOOKALIKE));
  await expect(page.getByTestId("withdraw-preview-lookalike")).toHaveText("This is not the USDC on the reviewed list.");
});

test("reviewed USDC shows no unreviewed label, contract row or warning at confirm time", async ({ page }) => {
  await addPasskeyAuthenticator(page);
  await funded(page);
  await page.goto("/withdraw");
  await page.getByTestId("withdraw-connect").click();
  await page.getByTestId("asset-USDC").click();
  await page.getByTestId("withdraw-amount").fill("1");
  await page.getByTestId("withdraw-recipient").fill(RECIPIENT);
  await page.getByTestId("withdraw-preview").click();
  await expect(page.getByTestId("withdraw-preview-amount")).toHaveText("1 USDC");
  await expect(page.getByTestId("withdraw-preview-contract")).toHaveCount(0);
  await expect(page.getByTestId("withdraw-preview-lookalike")).toHaveCount(0);
});
