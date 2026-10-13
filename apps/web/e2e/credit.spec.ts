import { expect, test, type Page } from "@playwright/test";
import { APP_ORIGIN } from "./ports";
import { decodeFunctionData, erc20Abi, parseTransaction, type TransactionSerialized } from "viem";
import manifest from "../../../packages/protocols/registry/rate/manifest.json";
import { EXTRA_TOKEN, MOCK_CHAIN_PORT, TREASURY } from "../playwright.config";
import { mockRpc } from "./rpcMock";
import { dismissOnboardingWhenItBlocks } from "./onboarding";
import { signIn } from "./signIn";

/**
 * Adding credit with USDC, end to end: the page asks the wallet for a transfer, the wallet asks the person, the
 * signed transaction reaches the (mock) chain, and the SERVER reads that chain itself before crediting anything.
 */

const USDC = manifest.tokens["5042002"].find((t) => t.symbol === "USDC")!.address.toLowerCase();
const MOCK_CHAIN = `http://127.0.0.1:${MOCK_CHAIN_PORT}`;
const MINED_AT = 0x100;

/** Move the head of the chain the server reads. A transaction is mined at MINED_AT, so MINED_AT + n - 1 gives it n confirmations. */
/** The USDC card. Another test may add a payment token at the same time, which shows its own card. */
const usdcCard = (page: Page) => page.locator("section", { has: page.getByRole("heading", { name: "Add credit with USDC" }) });
const setHead = (head: number) => fetch(`${MOCK_CHAIN}/__control`, { method: "POST", body: JSON.stringify({ head }) });
test.beforeEach(() => setHead(MINED_AT).then(() => undefined));

async function addPasskeyAuthenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true },
  });
  await dismissOnboardingWhenItBlocks(page);
}

/** What the wallet broadcast in the browser is handed to the chain the server reads, as a real network would do. */
async function mine(raw: string) {
  const response = await fetch(MOCK_CHAIN, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [raw] }) });
  expect(((await response.json()) as { result?: string }).result).toMatch(/^0x[0-9a-f]{64}$/);
}

test("adding credit with USDC: the wallet asks, the chain is checked by the server, and the credit arrives once", async ({ page }) => {
  await addPasskeyAuthenticator(page);
  const rpc = await mockRpc(page.context(), { nativeBalance: 10n ** 20n, tokenBalances: { [USDC]: 100_000_000n }, tokenMeta: { [USDC]: { symbol: "USDC", decimals: 6 } } });
  await signIn(page);
  await expect(page.getByTestId("credit-balance")).toHaveText("$0.0000", { timeout: 30_000 });

  await page.getByTestId("credit-link").click();
  await expect(page.getByRole("heading", { name: "Credit", level: 1 })).toBeVisible();
  await expect(page.getByTestId("credit-spendable")).toHaveText("$0.0000");
  await page.getByRole("button", { name: "$10" }).click();
  await usdcCard(page).getByTestId("topup-review").click();
  await expect(usdcCard(page).getByTestId("topup-review-amount")).toHaveText("10 USDC");
  await expect(usdcCard(page).getByTestId("topup-review-treasury")).toHaveText(TREASURY);

  // A transfer always asks, whatever rules exist. The wallet describes it from the calldata.
  const wallet = page.frameLocator('iframe[src*="/wallet-frame/confirm"]');
  await wallet.getByRole("button", { name: "Send 10 USDC" }).click();

  await expect(page.getByTestId("pending-topup")).toBeVisible({ timeout: 30_000 });
  expect(rpc.sent).toHaveLength(1);
  const sent = parseTransaction(rpc.sent[0]! as TransactionSerialized);
  expect(sent.to?.toLowerCase()).toBe(USDC);
  expect(decodeFunctionData({ abi: erc20Abi, data: sent.data! }).args).toEqual([TREASURY, 10_000_000n]);

  // Until the chain the SERVER reads has the transaction, nothing is credited.
  await expect(page.getByTestId("pending-topup-status")).toHaveText(/Confirming|Checking/);
  await expect(page.getByTestId("credit-spendable")).toHaveText("$0.0000");

  // Mined, and one block deep: seen, and still not credited. The server wants three.
  await mine(rpc.sent[0]!);
  await expect(page.getByTestId("pending-topup-status")).toHaveText("Confirming: 1 of 3", { timeout: 30_000 });
  await expect(page.getByTestId("credit-spendable")).toHaveText("$0.0000");

  await setHead(MINED_AT + 2);
  await expect(page.getByTestId("pending-topup-status")).toHaveText("Credited", { timeout: 30_000 });
  await expect(page.getByTestId("credit-spendable")).toHaveText("$10.00");
  await expect(page.getByRole("cell", { name: /Added with USDC/ })).toContainText("Test");

  // Asking again for the same deposit credits nothing more.
  const again = await page.request.post("/api/billing/usdc", { headers: { origin: APP_ORIGIN }, data: { chainId: 5042002, hash: await page.getByTestId("pending-topup").locator("code").innerText() } });
  expect(await again.json()).toEqual({ status: "already-credited" });

  // And it survives a reload: the credit is the server's, not the page's.
  await page.reload();
  await expect(page.getByTestId("credit-spendable")).toHaveText("$10.00", { timeout: 30_000 });
});

test("the prompt says what credit is left and roughly how many replies it buys, and updates after a reply", async ({ page }) => {
  await addPasskeyAuthenticator(page);
  await mockRpc(page.context(), { nativeBalance: 10n ** 20n, tokenBalances: { [USDC]: 100_000_000n }, tokenMeta: { [USDC]: { symbol: "USDC", decimals: 6 } } });
  await signIn(page);
  const chip = page.getByTestId("credit-chip");
  await expect(chip).toHaveText("$0.0000 credit · add more to chat", { timeout: 30_000 });
  await expect(chip).toHaveAttribute("data-tone", "warn");
  await expect(chip).toHaveAttribute("href", "/settings/credit");

  // The test grant is $1.00. A send of the scripted model needs (12,000 × 3 + 4,096 × 15) × 1.3 = $0.126672 held,
  // so one reply is certain and the other $0.873328 is counted in minimum holds of $0.01: 1 + 87.
  expect((await page.request.post("/api/dev/credit", { headers: { origin: APP_ORIGIN } })).ok()).toBe(true);
  await page.reload();
  await expect(page.getByTestId("credit-balance")).toHaveText("$1.00", { timeout: 30_000 });
  await expect(chip).toHaveText("$1.00 credit · about 88 more replies");
  expect(((await (await page.request.get("/api/auth/session")).json()) as { credit: unknown }).credit).toEqual({ spendableMicrousd: "1000000", heldMicrousd: "0", minHoldMicrousd: "10000", sendFloorMicrousd: "126672", blocked: false });
  await expect(chip).not.toHaveAttribute("data-tone", "warn");

  // After a reply, the floor is the one that reply reported for this chat, and the rest is counted at its cost, $0.00624.
  await page.getByTestId("chat-input").fill("hello there");
  await page.getByTestId("chat-send").click();
  await expect(page.getByTestId("message-assistant")).toContainText("Hello from the scripted model.");
  await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}$/);
  const saved = (await (await page.request.get(`/api/chats/${page.url().split("/c/")[1]}`)).json()) as { messages: Array<{ role: string; metadata?: { costMicrousd?: string; sendFloorMicrousd?: string } }> };
  const reply = saved.messages.find((m) => m.role === "assistant")!.metadata!;
  expect(reply.costMicrousd).toBe("6240");
  const left = 1 + Math.floor((993_760 - Number(reply.sendFloorMicrousd)) / 6_240);
  await expect(chip).toHaveText(`$0.99 credit · about ${left} more replies`);
  await expect(page.getByTestId("credit-held")).toHaveCount(0); // the hold was settled
});

test("a deposit someone else made cannot be claimed", async ({ page, browser }) => {
  // Alice deposits.
  await addPasskeyAuthenticator(page);
  const rpc = await mockRpc(page.context(), { nativeBalance: 10n ** 20n, tokenBalances: { [USDC]: 100_000_000n }, tokenMeta: { [USDC]: { symbol: "USDC", decimals: 6 } } });
  await page.goto("/settings/credit");
  await page.getByRole("button", { name: "Continue with a passkey" }).click();
  await usdcCard(page).getByTestId("topup-review").click({ timeout: 30_000 });
  await page.frameLocator('iframe[src*="/wallet-frame/confirm"]').getByRole("button", { name: "Send 5 USDC" }).click();
  await expect(page.getByTestId("pending-topup")).toBeVisible({ timeout: 30_000 });
  await mine(rpc.sent[0]!);
  await setHead(MINED_AT + 2);
  const hash = await page.getByTestId("pending-topup").locator("code").innerText();
  await expect(page.getByTestId("pending-topup-status")).toHaveText("Credited", { timeout: 30_000 });

  // Mallory, another wallet in another browser, submits Alice's hash.
  const context = await browser.newContext();
  const other = await context.newPage();
  await addPasskeyAuthenticator(other);
  await mockRpc(context, { nativeBalance: 0n, tokenBalances: {}, tokenMeta: { [USDC]: { symbol: "USDC", decimals: 6 } } });
  await signIn(other);
  await expect(other.getByTestId("credit-balance")).toBeVisible({ timeout: 30_000 });
  const claim = await other.request.post("/api/billing/usdc", { headers: { origin: APP_ORIGIN }, data: { chainId: 5042002, hash } });
  expect(((await claim.json()) as { status: string }).status).toBe("rejected");
  await other.reload();
  await expect(other.getByTestId("credit-balance")).toHaveText("$0.0000", { timeout: 30_000 });
  await context.close();
});

test("a deposit this page has no record of can be checked by its hash, and one that never appears can be put away", async ({ page }) => {
  await addPasskeyAuthenticator(page);
  await mockRpc(page.context(), { nativeBalance: 10n ** 20n, tokenBalances: { [USDC]: 100_000_000n }, tokenMeta: { [USDC]: { symbol: "USDC", decimals: 6 } } });
  await page.goto("/settings/credit");
  await page.getByRole("button", { name: "Continue with a passkey" }).click();
  await page.getByText("Already sent USDC and do not see it here?").click({ timeout: 30_000 });
  await page.getByTestId("claim-hash").fill(`0x${"cd".repeat(32)}`);
  await page.getByTestId("claim-submit").click();
  await expect(page.getByTestId("pending-topup-status")).toHaveText("Confirming: 0 of 3", { timeout: 30_000 });
  await page.getByTestId("pending-topup-dismiss").click();
  await expect(page.getByTestId("pending-topup")).toHaveCount(0);
});

/**
 * The operator's own token, end to end: an admin adds it on /admin at a fixed price, a person pays with it, and the
 * server credits what the chain shows at that price. The mock chain calls it "TEST", with 6 decimals. In this file
 * because it moves the same mock chain's head as the USDC test, so the two must not run at once.
 */
const TOKEN = EXTRA_TOKEN.toLowerCase();

test("an admin prices the app's token, a person pays with it, and the credit arrives at that price", async ({ page }) => {
  await addPasskeyAuthenticator(page);
  // 5 TEST in the wallet, and no USDC at all.
  const rpc = await mockRpc(page.context(), { nativeBalance: 10n ** 20n, tokenBalances: { [TOKEN]: 5_000_000n, [USDC]: 0n }, tokenMeta: { [TOKEN]: { symbol: "TEST", decimals: 6 }, [USDC]: { symbol: "USDC", decimals: 6 } } });
  await signIn(page);
  await expect(page.getByTestId("credit-balance")).toHaveText("$0.0000", { timeout: 30_000 });

  // The admin adds the token. Its symbol and decimals come from the chain the server reads.
  await page.getByRole("link", { name: "Admin" }).click();
  await page.getByTestId("admin-token-add").click();
  await page.getByTestId("admin-token-address").fill(EXTRA_TOKEN);
  await page.getByTestId("admin-token-price").fill("0.5");
  await page.getByLabel(/open faucet/).uncheck();
  await page.getByTestId("admin-token-save").click();
  await expect(page.getByTestId("admin-token-row")).toContainText("1 TEST buys $0.50 of credit · 6 decimals");

  // A price that is not a dollar amount is refused, and nothing changes.
  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByTestId("admin-token-price").fill("0");
  await page.getByTestId("admin-token-save").click();
  await expect(page.getByText(/must be a dollar amount above zero/)).toBeVisible();

  // The person pays 2 TEST. With no USDC, the USDC card says to deposit first.
  await page.getByRole("link", { name: "Credit" }).first().click();
  await expect(page.getByRole("heading", { name: "Add credit with TEST" })).toBeVisible();
  await expect(page.getByTestId("topup-deposit-first")).toContainText("no USDC");
  const card = page.locator("section", { has: page.getByRole("heading", { name: "Add credit with TEST" }) });
  await card.getByTestId("topup-amount").fill("2");
  await card.getByTestId("topup-review").click();
  await expect(card.getByTestId("topup-review-amount")).toHaveText("2 TEST");
  await expect(card.getByTestId("topup-review-treasury")).toHaveText(TREASURY);
  await page.frameLocator('iframe[src*="/wallet-frame/confirm"]').getByRole("button", { name: "Send 2 TEST" }).click();

  await expect(page.getByTestId("pending-topup")).toContainText("2 TEST", { timeout: 30_000 });
  const sent = parseTransaction(rpc.sent[0]! as TransactionSerialized);
  expect(sent.to?.toLowerCase()).toBe(TOKEN);
  expect(decodeFunctionData({ abi: erc20Abi, data: sent.data! }).args).toEqual([TREASURY, 2_000_000n]);

  await mine(rpc.sent[0]!);
  await setHead(MINED_AT + 2);
  await expect(page.getByTestId("pending-topup-status")).toHaveText("Credited", { timeout: 30_000 });
  await expect(page.getByTestId("credit-spendable")).toHaveText("$1.00");
  await expect(page.getByRole("cell", { name: /Added with tokens/ })).toContainText("Test");

  // Switched off again, as the admin would: it is no longer offered, and the suite's other tests do not see it.
  const off = await page.request.post("/api/admin/payment-tokens", { headers: { origin: APP_ORIGIN }, data: { chainId: 5042002, address: EXTRA_TOKEN, priceUsd: "0.5", enabled: false, faucet: false } });
  expect(off.ok()).toBe(true);
  await page.reload();
  await expect(page.getByTestId("credit-spendable")).toHaveText("$1.00", { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Add credit with TEST" })).toHaveCount(0);
});
