import { expect, test, type Page } from "@playwright/test";
import { decodeFunctionData, erc20Abi, getAddress, keccak256, parseTransaction, parseUnits, recoverTransactionAddress, type TransactionSerialized } from "viem";
import { mockRpc } from "./rpcMock";
import { dismissOnboardingWhenItBlocks } from "./onboarding";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ARC = 5042002;
// Arc's USDC and EURC, as vendored in @repo/protocols (registry/rate/manifest.json).
const USDC = "0x3600000000000000000000000000000000000000";
const EURC = "0x89b50855aa3be2f677cd6303cec089b5f319d72a";
// A throwaway recipient: valid EIP-55 because it has no letters.
const RECIPIENT = "0x0000000000000000000000000000000000001234";

async function addPasskeyAuthenticator(page: Page) {
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
    tokenBalances: { [USDC]: 100_000_000n, [EURC]: 0n },
    tokenMeta: { [USDC]: { symbol: "USDC", decimals: 6 }, [EURC]: { symbol: "EURC", decimals: 6 } },
  });
}

test("deposit shows the full address, a QR code and the network warning", async ({ page }) => {
  await addPasskeyAuthenticator(page);
  await funded(page);
  await page.goto("/deposit");
  await page.getByTestId("deposit-connect").click();

  await expect(page.getByTestId("deposit-address")).toHaveText(ADDRESS, { timeout: 30_000 });
  await expect(page.getByTestId("deposit-qr")).toHaveAttribute("src", /^data:image\/png;base64,/);
  await expect(page.getByText("This network only.")).toBeVisible();
  // Arc's gas asset IS its USDC, so exactly one USDC row may appear.
  await expect(page.getByTestId("asset-USDC")).toHaveCount(1);
  await expect(page.getByTestId("asset-USDC")).toContainText("100");

  const before = await page.getByTestId("deposit-address").innerText();
  await page.getByTestId("network-11155931").click();
  await expect(page.getByTestId("deposit-address")).toHaveText(before);
  await expect(page.getByTestId("asset-ETH")).toBeVisible();
});

test("withdraw refuses a shortened address and an amount over the balance, beside the field at fault", async ({ page }) => {
  await addPasskeyAuthenticator(page);
  await funded(page);
  await page.goto("/withdraw");
  await page.getByTestId("withdraw-connect").click();
  await page.getByTestId("asset-USDC").click();

  await page.getByTestId("withdraw-amount").fill("25");
  await page.getByTestId("withdraw-recipient").fill("0x38A1…7f0A");
  await page.getByTestId("withdraw-preview").click();
  await expect(page.getByTestId("withdraw-recipient-error")).toContainText("not a full address");

  await page.getByTestId("withdraw-recipient").fill(RECIPIENT);
  await page.getByTestId("withdraw-amount").fill("100.5");
  await expect(page.getByTestId("withdraw-amount-error")).toContainText("more USDC than this wallet holds");
  await expect(page.getByTestId("withdraw-preview-amount")).toHaveCount(0);
});

test("Max leaves the network fee behind when the asset also pays gas", async ({ page }) => {
  await addPasskeyAuthenticator(page);
  await funded(page);
  await page.goto("/withdraw");
  await page.getByTestId("withdraw-connect").click();
  await page.getByTestId("asset-USDC").click();
  await page.getByTestId("withdraw-max").click();
  const max = Number(await page.getByTestId("withdraw-amount").inputValue());
  expect(max).toBeGreaterThan(99);
  expect(max).toBeLessThan(100);
});

test("the wallet signs exactly the transfer that was previewed", async ({ page }) => {
  await addPasskeyAuthenticator(page);
  const rpc = await funded(page);
  await page.goto("/deposit");
  await page.getByTestId("deposit-connect").click();
  await expect(page.getByTestId("deposit-address")).toHaveText(ADDRESS, { timeout: 30_000 });
  const walletAddress = await page.getByTestId("deposit-address").innerText();
  await page.getByRole("link", { name: "Withdraw", exact: true }).first().click();
  // The deposit page has an asset list too, with the same test ids. Wait for the withdraw page, or a fast click lands on the page being left.
  await expect(page).toHaveURL(/\/withdraw$/);
  await expect(page.getByRole("heading", { name: "Withdraw", level: 1 })).toBeVisible();
  await page.getByTestId("asset-USDC").click();
  await expect(page.getByTestId("asset-USDC")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("withdraw-amount").fill("25");
  await page.getByTestId("withdraw-recipient").fill(RECIPIENT);
  await page.getByTestId("withdraw-preview").click();

  await expect(page.getByTestId("withdraw-preview-amount")).toHaveText("25 USDC");
  await expect(page.getByTestId("withdraw-preview-recipient")).toHaveText(RECIPIENT);
  await expect(page.getByText("This cannot be undone.")).toBeVisible();

  const previewAmount = await page.getByTestId("withdraw-preview-amount").innerText();
  const previewRecipient = await page.getByTestId("withdraw-preview-recipient").innerText();

  // The confirm button lives in the wallet frame, not in the app.
  await page.frameLocator('iframe[src*="/wallet-frame/confirm"]').getByRole("button", { name: "Confirm transfer" }).click();

  await expect(page.getByTestId("transfer-result")).toHaveAttribute("data-state", "confirmed", { timeout: 30_000 });

  expect(rpc.sent).toHaveLength(1);
  const raw = rpc.sent[0]! as TransactionSerialized;
  // The hash shown is the hash of what was really broadcast, not a value echoed back.
  await expect(page.getByTestId("transfer-hash")).toHaveText(keccak256(raw));

  // Signed by the connected passkey wallet and nobody else.
  expect(await recoverTransactionAddress({ serializedTransaction: raw })).toBe(getAddress(walletAddress));

  // Compared with what the PREVIEW DISPLAYED, scraped from the page before confirming.
  const tx = parseTransaction(raw);
  expect(tx.chainId).toBe(ARC);
  expect(tx.to?.toLowerCase()).toBe(USDC);
  expect(tx.value ?? 0n).toBe(0n);
  const call = decodeFunctionData({ abi: erc20Abi, data: tx.data! });
  expect(call.functionName).toBe("transfer");
  const [shownAmount, shownSymbol] = previewAmount.split(" ");
  expect(shownSymbol).toBe("USDC");
  expect(call.args).toEqual([getAddress(previewRecipient), parseUnits(shownAmount!, 6)]);

  // The receipt is recorded on this device and offered as a recent recipient next time.
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByText("Recent on this device")).toBeVisible();
  await expect(page.getByRole("button", { name: RECIPIENT })).toBeVisible();
});

test("a reverted transfer says so and does not claim success", async ({ page }) => {
  await addPasskeyAuthenticator(page);
  await mockRpc(page.context(), { nativeBalance: 10n ** 20n, tokenBalances: { [USDC]: 100_000_000n }, tokenMeta: { [USDC]: { symbol: "USDC", decimals: 6 }, [EURC]: { symbol: "EURC", decimals: 6 } }, receiptStatus: "reverted" });
  await page.goto("/withdraw");
  await page.getByTestId("withdraw-connect").click();
  await page.getByTestId("asset-USDC").click();
  await page.getByTestId("withdraw-amount").fill("1");
  await page.getByTestId("withdraw-recipient").fill(RECIPIENT);
  await page.getByTestId("withdraw-preview").click();
  await page.frameLocator('iframe[src*="/wallet-frame/confirm"]').getByRole("button", { name: "Confirm transfer" }).click();
  await expect(page.getByTestId("transfer-result")).toHaveAttribute("data-state", "reverted", { timeout: 30_000 });
  await expect(page.getByText("Nothing was sent.")).toBeVisible();
});

test("with the gas price unreadable, Max and Preview stay off instead of offering the whole balance", async ({ page }) => {
  await addPasskeyAuthenticator(page);
  await mockRpc(page.context(), { nativeBalance: 10n ** 20n, tokenBalances: { [USDC]: 100_000_000n }, tokenMeta: { [USDC]: { symbol: "USDC", decimals: 6 }, [EURC]: { symbol: "EURC", decimals: 6 } }, failGasPrice: true });
  await page.goto("/withdraw");
  await page.getByTestId("withdraw-connect").click();
  await page.getByTestId("asset-USDC").click();
  await expect(page.getByTestId("withdraw-fee-unknown")).toBeVisible();
  await expect(page.getByTestId("withdraw-max")).toBeDisabled();

  await page.getByTestId("withdraw-amount").fill("100");
  await page.getByTestId("withdraw-recipient").fill(RECIPIENT);
  await page.getByTestId("withdraw-preview").click();
  await expect(page.getByTestId("withdraw-amount-error")).toContainText("network fee");
  await expect(page.getByTestId("withdraw-preview-amount")).toHaveCount(0);
});

test("a reverted withdrawal is not kept as a sent amount or offered as a past recipient", async ({ page }) => {
  await addPasskeyAuthenticator(page);
  await mockRpc(page.context(), { nativeBalance: 10n ** 20n, tokenBalances: { [USDC]: 100_000_000n }, tokenMeta: { [USDC]: { symbol: "USDC", decimals: 6 }, [EURC]: { symbol: "EURC", decimals: 6 } }, receiptStatus: "reverted" });
  await page.goto("/withdraw");
  await page.getByTestId("withdraw-connect").click();
  await page.getByTestId("asset-USDC").click();
  await page.getByTestId("withdraw-amount").fill("1");
  await page.getByTestId("withdraw-recipient").fill(RECIPIENT);
  await page.getByTestId("withdraw-preview").click();
  await page.frameLocator('iframe[src*="/wallet-frame/confirm"]').getByRole("button", { name: "Confirm transfer" }).click();
  await expect(page.getByTestId("transfer-result")).toHaveAttribute("data-state", "reverted", { timeout: 30_000 });
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByText("Recent on this device")).toHaveCount(0);
  await expect(page.getByRole("button", { name: RECIPIENT })).toHaveCount(0);
});
