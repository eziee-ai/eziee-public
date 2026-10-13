import type { Page } from "@playwright/test";

/**
 * The app opens the chat (and the tokens page, which follows it) on RISE Testnet. Suites that mock Arc start there,
 * unless a test has already chosen a network itself.
 */
export async function startOnArc(page: Page) {
  await page.addInitScript(() => {
    if (!localStorage.getItem("wlt.chat-selection")) localStorage.setItem("wlt.chat-selection", JSON.stringify({ model: "openai/gpt-5.5", protocol: "auto", chainId: 5042002 }));
  });
}
