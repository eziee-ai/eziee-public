import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { createPublicClient, erc20Abi, getAddress, http, type Address } from "viem";

/**
 * Deposit, chat with the real model, and withdraw, live on Arc testnet.
 *
 *   LIVE_RECIPIENT=0x… pnpm --filter web exec playwright test -c e2e-live/playwright.live.config.ts
 *
 * The run creates a fresh passkey wallet, writes its address to e2e-live/out/live-address.txt and waits (up to
 * 40 minutes) for at least 2 USDC on Arc testnet: send it from https://faucet.circle.com. The withdrawal sends
 * 1 USDC to LIVE_RECIPIENT. The model's replies are logged word for word to e2e-live/out/live-log.txt.
 */
const USDC = "0x3600000000000000000000000000000000000000" as const; // Arc testnet USDC, checked with `cast call … symbol()`
const RECIPIENT = getAddress(process.env.LIVE_RECIPIENT ?? "");
const OUT = `${__dirname}/out`;
const arc = createPublicClient({ transport: http("https://rpc.testnet.arc.network") });
const usdc = (a: Address) => arc.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [a] });
const log = (line: string) => { appendFileSync(`${OUT}/live-log.txt`, `${new Date().toISOString()} ${line}\n`); console.log(line); };
const oneLine = (text: string) => text.replace(/\s+/g, " ").slice(0, 400);

async function send(page: Page, text: string) {
  const before = await page.getByTestId("message-assistant").count();
  await page.getByTestId("chat-input").fill(text);
  await page.getByTestId("chat-send").click();
  return before;
}
async function reply(page: Page, before: number) {
  await expect(page.getByTestId("message-assistant").nth(before)).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId("chat-send")).toBeEnabled({ timeout: 120_000 });
  return (await page.getByTestId("message-assistant").last().innerText()).trim();
}

test("live: deposit, chat with the real model, withdraw", async ({ page }) => {
  mkdirSync(OUT, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true },
  });
  const skip = page.getByRole("button", { name: "Skip for now" });
  await page.addLocatorHandler(skip, async () => { await skip.click(); });
  const wallet = page.frameLocator('iframe[src*="/wallet-frame/confirm"]');

  // 1. Deposit: a real address, then the onchain balance once it is funded.
  await page.goto("/deposit");
  await page.getByTestId("deposit-connect").click();
  await expect(page.getByTestId("deposit-address")).toHaveText(/^0x[0-9a-fA-F]{40}$/, { timeout: 60_000 });
  const me = getAddress(await page.getByTestId("deposit-address").innerText());
  writeFileSync(`${OUT}/live-address.txt`, me);
  log(`WALLET ${me}: waiting for USDC on Arc testnet`);
  await expect.poll(() => usdc(me), { timeout: 40 * 60_000, intervals: [10_000] }).toBeGreaterThanOrEqual(2_000_000n);
  const funded = await usdc(me);
  log(`FUNDED ${Number(funded) / 1e6} USDC`);
  await page.reload();
  await expect(page.getByTestId("asset-USDC")).toContainText(String(Math.floor(Number(funded) / 1e6)), { timeout: 60_000 });
  log("PASS deposit page shows the onchain balance");

  // 2. Chat with the real model. Credit is free here, so the chat must answer.
  await page.goto("/home");
  let n = await send(page, "What tokens do I have in my wallet, and how much of each?");
  const balance = await reply(page, n);
  log(`CHAT balance -> ${oneLine(balance)}`);
  expect(balance).toMatch(/USDC/i);

  n = await send(page, "Swap 1 USDC for EURC on Rate.");
  const asked = await wallet.getByTestId("card-deny").waitFor({ timeout: 180_000 }).then(() => true, () => false);
  if (asked) {
    log(`CHAT swap -> wallet card: ${oneLine(await wallet.locator("body").innerText())}`);
    await wallet.getByTestId("card-deny").click();
    await expect(page.getByText("You denied this in your wallet. Nothing was signed.")).toBeVisible({ timeout: 60_000 });
  }
  log(`CHAT swap -> ${asked ? "card shown, denied" : "NO wallet card"}; reply: ${oneLine(await reply(page, n))}`);
  expect.soft(asked, "the model should have asked the wallet to swap").toBe(true);

  n = await send(page, "I want to add more funds to my wallet.");
  const toDeposit = await page.waitForURL(/\/deposit/, { timeout: 120_000 }).then(() => true, () => false);
  log(`CHAT fund -> ${toDeposit ? "opened /deposit" : `did NOT open /deposit; reply: ${oneLine(await reply(page, n))}`}`);
  expect.soft(toDeposit, "the model should open the deposit screen").toBe(true);

  // 3. Withdraw 1 USDC and check that it arrived onchain.
  const before = await usdc(RECIPIENT);
  await page.goto("/withdraw");
  await page.getByTestId("asset-USDC").click();
  await page.getByTestId("withdraw-amount").fill("1");
  await page.getByTestId("withdraw-recipient").fill(RECIPIENT);
  await page.getByTestId("withdraw-preview").click();
  await expect(page.getByTestId("withdraw-preview-amount")).toHaveText("1 USDC");
  await wallet.getByRole("button", { name: "Confirm transfer" }).click({ timeout: 60_000 });
  await expect(page.getByTestId("transfer-result")).toHaveAttribute("data-state", "confirmed", { timeout: 5 * 60_000 });
  const hash = await page.getByTestId("transfer-hash").innerText();
  await expect.poll(async () => (await usdc(RECIPIENT)) - before, { timeout: 60_000 }).toBe(1_000_000n);
  log(`PASS withdraw: 1 USDC arrived onchain, tx ${hash}`);
});
