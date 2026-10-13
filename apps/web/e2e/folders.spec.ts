import { expect, test, type Page } from "@playwright/test";
import manifest from "../../../packages/protocols/registry/rate/manifest.json";
import { APP_ORIGIN } from "./ports";
import { mockRpc } from "./rpcMock";
import { dismissOnboardingWhenItBlocks } from "./onboarding";
import { signIn } from "./signIn";
import { startOnArc } from "./startOnArc";

const [USDC, EURC] = manifest.tokens["5042002"].map((t) => t.address.toLowerCase()) as [string, string];

async function setUp(page: Page) {
  await startOnArc(page);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true },
  });
  await dismissOnboardingWhenItBlocks(page);
  await mockRpc(page.context(), {
    nativeBalance: 10n ** 20n,
    tokenBalances: { [USDC]: 100_000_000n, [EURC]: 0n },
    tokenMeta: { [USDC]: { symbol: "USDC", decimals: 6 }, [EURC]: { symbol: "EURC", decimals: 6 } },
  });
  await signIn(page);
  await expect(page.getByTestId("credit-balance")).toBeVisible({ timeout: 30_000 });
  expect((await page.request.post("/api/dev/credit", { headers: { origin: APP_ORIGIN } })).ok()).toBe(true);
}

const history = (page: Page) => page.getByRole("navigation", { name: "Chat history" });

test("folders: make one, file a chat in it, fold it away, rename it, and delete it without losing the chat", async ({ page }) => {
  await setUp(page);
  await page.getByTestId("chat-input").fill("hello there");
  await page.getByTestId("chat-send").click();
  await expect(page.getByTestId("message-assistant")).toContainText("Hello from the scripted model.");
  const chatLink = history(page).getByRole("link", { name: "hello there" });
  await expect(chatLink).toBeVisible();

  // Make a folder in place.
  await history(page).getByTestId("folder-new").click();
  await history(page).getByTestId("folder-name").fill("Trading ideas");
  await history(page).getByTestId("folder-name").press("Enter");
  const folder = history(page).locator('[data-testid^="folder-"]').filter({ has: page.getByTestId("folder-toggle") });
  await expect(folder.getByTestId("folder-toggle")).toContainText("Trading ideas");
  await expect(folder).toContainText("No chats here yet");

  // File the chat in it from the chat's own menu, by keyboard.
  const row = history(page).getByTestId("chat-row").filter({ hasText: "hello there" });
  await row.getByTestId("chat-menu").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu")).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Trading ideas" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(folder.getByRole("link", { name: "hello there" })).toBeVisible();
  await expect(folder.getByTestId("folder-toggle")).toContainText("1");
  await expect(history(page)).toContainText("Every chat is in a folder.");

  // Fold it away; the fold survives a reload.
  await folder.getByTestId("folder-toggle").click();
  await expect(folder.getByTestId("folder-toggle")).toHaveAttribute("aria-expanded", "false");
  await expect(folder.getByRole("link", { name: "hello there" })).toHaveCount(0);
  await page.reload();
  await expect(folder.getByTestId("folder-toggle")).toHaveAttribute("aria-expanded", "false", { timeout: 30_000 });
  await folder.getByTestId("folder-toggle").click();
  await expect(folder.getByRole("link", { name: "hello there" })).toBeVisible();

  // Search still finds a filed chat.
  await page.getByLabel("Search chats").fill("hello");
  await expect(history(page).getByRole("link", { name: "hello there" })).toBeVisible();
  await page.getByLabel("Search chats").fill("");

  // Rename.
  await folder.getByTestId("folder-menu").click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await history(page).getByTestId("folder-rename-input").fill("Swaps");
  await history(page).getByTestId("folder-rename-input").press("Enter");
  await expect(folder.getByTestId("folder-toggle")).toContainText("Swaps");

  // Delete asks in place, and the chat survives, back among the loose chats.
  await folder.getByTestId("folder-menu").click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await expect(folder).toContainText("Its chats are kept");
  await folder.getByTestId("folder-delete-confirm").click();
  await expect(history(page).getByTestId("folder-toggle")).toHaveCount(0);
  await expect(history(page).getByRole("link", { name: "hello there" })).toBeVisible();
});

test("a new chat started from a folder's menu is filed in that folder", async ({ page }) => {
  await setUp(page);
  await history(page).getByTestId("folder-new").click();
  await history(page).getByTestId("folder-name").fill("Yield");
  await history(page).getByTestId("folder-name").press("Enter");
  const folder = history(page).locator('[data-testid^="folder-"]').filter({ has: page.getByTestId("folder-toggle") });
  await expect(folder.getByTestId("folder-toggle")).toContainText("Yield");

  await folder.getByTestId("folder-menu").click();
  await page.getByRole("menuitem", { name: "New chat in folder" }).click();
  await expect(page).toHaveURL(/\/home\?folder=[0-9a-f-]{36}$/);
  await page.getByTestId("chat-input").fill("hello there");
  await page.getByTestId("chat-send").click();
  await expect(page.getByTestId("message-assistant")).toContainText("Hello from the scripted model.");

  await expect(folder.getByRole("link", { name: "hello there" })).toBeVisible({ timeout: 30_000 });
  await expect(folder.getByTestId("folder-toggle")).toContainText("1");
});
