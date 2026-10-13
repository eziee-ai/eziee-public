import type { Page } from "@playwright/test";

/**
 * The brand's first-run welcome covers the whole app the first time an address signs in,
 * over whichever screen that happens on. A person clicks it away before carrying on; so
 * does the suite, and only when it is actually in the way of the next action.
 *
 * Registered before the first navigation, so no test has to know where the modal lands.
 */
export async function dismissOnboardingWhenItBlocks(page: Page) {
  const skip = page.getByRole("button", { name: "Skip for now" });
  await page.addLocatorHandler(skip, async () => {
    await skip.click();
  });
}
