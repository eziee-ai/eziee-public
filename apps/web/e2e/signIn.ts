import { expect, type Page } from "@playwright/test";

/**
 * The chat is behind sign-in: signed out, /home is replaced by /login. Sign in there, with the page's
 * virtual authenticator, and land on `next` (the new chat by default).
 */
export async function signIn(page: Page, next = "/home") {
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  await page.getByTestId("login-passkey").click();
  await expect(page).toHaveURL(new RegExp(`${next.replace(/[/]/g, "\\/")}$`), { timeout: 30_000 });
}
