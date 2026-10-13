import { expect, test, type Page } from "@playwright/test";
import { encodeFunctionData, erc20Abi, parseAbi, type Hex } from "viem";
import manifest from "../../../packages/protocols/registry/rate/manifest.json";
import { mockRpc } from "./rpcMock";
import { dismissOnboardingWhenItBlocks } from "./onboarding";

/**
 * The wallet's permission card and rule engine, driven end to end against the
 * REAL frame pages. The test speaks the frame protocol directly, exactly as
 * hostile script on the app origin could, so nothing here depends on (or adds)
 * app-side code.
 */

const ARC = 5042002;
const ENGINE = manifest.contracts["5042002"].matchingEngine.address as `0x${string}`;
const [USDC, EURC] = manifest.tokens["5042002"].map((t) => t.address as `0x${string}`) as [`0x${string}`, `0x${string}`];
const engineAbi = parseAbi(["function limitBuy((address base, address quote, uint256 price, uint256 amount, bool isMaker, uint32 n, address recipient) params)"]);

async function addPasskeyAuthenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true },
  });
  await dismissOnboardingWhenItBlocks(page);
}

async function connect(page: Page): Promise<`0x${string}`> {
  await page.goto("/deposit");
  await page.getByTestId("connect-button").click();
  await expect(page.getByTestId("wallet-address")).toBeVisible({ timeout: 30_000 });
  return (await page.getByTestId("wallet-address").innerText()) as `0x${string}`;
}

function limitBuy(recipient: `0x${string}`, quoteAmount: bigint): Hex {
  return encodeFunctionData({ abi: engineAbi, functionName: "limitBuy", args: [{ base: EURC, quote: USDC, price: 101_235_000n, amount: quoteAmount, isMaker: true, n: 20, recipient }] });
}

const envelope = (method: string, params: unknown) => ({ channel: "wlt.wallet-frame", v: 1, kind: "request", id: `${method}-${Math.random()}`, method, params });

/** Mount the confirm frame in the page, as the app would, and collect the events it posts back. */
async function mountConfirmFrame(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __events: unknown[]; __ready: boolean };
    w.__events = [];
    w.__ready = false;
    window.addEventListener("message", (e) => {
      const data = e.data as { kind?: string; data?: { event?: string } };
      if (data?.kind !== "event") return;
      if (data.data?.event === "ready") w.__ready = true;
      w.__events.push(data.data);
    });
    const frame = document.createElement("iframe");
    frame.id = "test-confirm";
    frame.src = "/wallet-frame/confirm?theme=light";
    frame.style.cssText = "position:fixed;right:0;bottom:0;width:440px;height:520px;border:0;background:white;z-index:9999";
    document.body.appendChild(frame);
  });
  await page.waitForFunction(() => (window as unknown as { __ready: boolean }).__ready);
}

async function present(page: Page, rpc: unknown) {
  const message = envelope("present", { chainId: ARC, rpc, label: "Allow once", disabled: false, variant: "card" });
  await page.evaluate((m) => (document.getElementById("test-confirm") as HTMLIFrameElement).contentWindow!.postMessage(m, window.location.origin), message);
}

/** Ask the HIDDEN frame to sign silently, as the app's connector does. Resolves to the reply envelope. */
async function requestSilently(page: Page, rpc: unknown): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
  return page.evaluate(
    ({ message }) =>
      new Promise((resolve) => {
        const frame = Array.from(document.querySelectorAll("iframe")).find((f) => f.src.endsWith("/wallet-frame")) as HTMLIFrameElement;
        const onMessage = (e: MessageEvent) => {
          const data = e.data as { kind?: string; id?: string };
          if (data?.kind !== "response" || data.id !== message.id) return;
          window.removeEventListener("message", onMessage);
          resolve(e.data);
        };
        window.addEventListener("message", onMessage);
        frame.contentWindow!.postMessage(message, window.location.origin);
      }),
    { message: envelope("request", { chainId: ARC, rpc }) },
  );
}

const card = (page: Page) => page.frameLocator("#test-confirm");
const tx = (data: Hex, extra: Record<string, unknown> = {}) => ({ method: "eth_sendTransaction", params: [{ to: ENGINE, data, value: "0x0", ...extra }] });

function chainMock(page: Page) {
  return mockRpc(page.context(), {
    nativeBalance: 10n ** 20n,
    tokenBalances: { [USDC.toLowerCase()]: 100_000_000n },
    tokenMeta: { [USDC.toLowerCase()]: { symbol: "USDC", decimals: 6 }, [EURC.toLowerCase()]: { symbol: "EURC", decimals: 6 } },
  });
}

test("Always allow: the card describes the order from calldata, saves a rule with limits, and later orders inside it sign without asking", async ({ page }) => {
  await addPasskeyAuthenticator(page);
  const rpc = await chainMock(page);
  const account = await connect(page);
  await mountConfirmFrame(page);

  await present(page, tx(limitBuy(account, 2_000_000n)));
  await expect(card(page).getByTestId("card-title")).toHaveText("Place order on Rate");
  await expect(card(page).getByTestId("card-spend")).toHaveText("2 USDC");
  await expect(card(page).getByTestId("card-receive")).toHaveText("EURC");

  await card(page).getByTestId("card-always").click();
  await expect(card(page).getByTestId("scope-risk")).toContainText("caps what goes in, not what comes back");
  await expect(card(page).getByTestId("scope-per-tx")).toHaveValue("2");
  await expect(card(page).getByTestId("scope-per-day")).toHaveValue("8");
  await card(page).getByTestId("scope-per-day").fill("5");
  await card(page).getByTestId("scope-save").click();

  await expect.poll(() => page.evaluate(() => (window as unknown as { __events: Array<{ event: string }> }).__events.some((e) => e.event === "submitted"))).toBe(true);
  expect(rpc.sent).toHaveLength(1);

  // Inside the rule: signed silently. 2 (the first order) + 2 = 4 of 5.
  expect((await requestSilently(page, tx(limitBuy(account, 2_000_000n)))).result).toMatch(/^0x[0-9a-f]{64}$/);
  // Over the per-transaction limit: asks.
  expect((await requestSilently(page, tx(limitBuy(account, 2_000_001n)))).error?.code).toBe(4300);
  // Inside per-transaction, but it would cross the day's limit (4 + 2 > 5): asks.
  expect((await requestSilently(page, tx(limitBuy(account, 2_000_000n)))).error?.code).toBe(4300);
  expect(rpc.sent).toHaveLength(2);

  await page.getByRole("link", { name: "Permissions" }).click();
  const row = page.frameLocator('[data-testid="wallet-rules-frame"]').getByTestId("rule-row");
  await expect(row).toContainText("Place order on Rate");
  await expect(row).toContainText("Up to 2 USDC per transaction");
  await expect(row).toContainText("4 of 5 used today");
});

test("with no rule, nothing that moves value is signed silently, however it is dressed", async ({ page }) => {
  await addPasskeyAuthenticator(page);
  const rpc = await chainMock(page);
  const account = await connect(page);

  const asks = [
    tx(limitBuy(account, 1_000_000n)),
    { method: "eth_sendTransaction", params: [{ to: USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [ENGINE, 1n] }) }] },
    { method: "eth_sendTransaction", params: [{ to: USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [ENGINE, 1n] }) }] },
    { method: "eth_sendTransaction", params: [{ to: ENGINE, value: "0x1" }] },
    { method: "personal_sign", params: ["0x" + Buffer.from("Withdraw everything").toString("hex"), account] },
    { method: "eth_signTypedData_v4", params: [account, "{}"] },
  ];
  for (const ask of asks) expect((await requestSilently(page, ask)).error?.code, JSON.stringify(ask).slice(0, 80)).toBe(4300);
  expect(rpc.sent).toHaveLength(0);
});

test("an EIP-7702 delegation hidden beside valid order calldata is never shown as just an order", async ({ page }) => {
  await addPasskeyAuthenticator(page);
  await chainMock(page);
  const account = await connect(page);
  await mountConfirmFrame(page);

  await present(page, tx(limitBuy(account, 2_000_000n), { authorizationList: [{ chainId: ARC, address: EURC, nonce: 0 }] }));
  await expect(card(page).getByTestId("card-deny")).toBeVisible();
  // Not decoded, so no friendly title, no rule offered, and the raw description names the delegation.
  await expect(card(page).getByTestId("card-title")).toHaveCount(0);
  await expect(card(page).getByTestId("card-always")).toHaveCount(0);
  await expect(card(page).getByText(/delegates/i)).toBeVisible();
});

test("swapping the request under the cursor resets the card, says so, and deadens its buttons for a beat", async ({ page }) => {
  await addPasskeyAuthenticator(page);
  await chainMock(page);
  const account = await connect(page);
  await mountConfirmFrame(page);

  await present(page, tx(limitBuy(account, 2_000_000n)));
  await expect(card(page).getByTestId("card-spend")).toHaveText("2 USDC");
  await card(page).getByTestId("card-always").click();
  await expect(card(page).getByTestId("scope-save")).toBeVisible();

  // The attacker re-presents a fifty-times larger order while the limit editor is open.
  await present(page, tx(limitBuy(account, 100_000_000n)));
  await expect(card(page).getByTestId("card-replaced")).toBeVisible();
  await expect(card(page).getByTestId("card-spend")).toHaveText("100 USDC");
  // The editor is closed again and the answer buttons start disabled.
  await expect(card(page).getByTestId("scope-save")).toHaveCount(0);
  await expect(card(page).getByTestId("card-once")).toBeDisabled();
  await expect(card(page).getByTestId("card-once")).toBeEnabled({ timeout: 3_000 });
});

test("Deny reports a rejection and signs nothing", async ({ page }) => {
  await addPasskeyAuthenticator(page);
  const rpc = await chainMock(page);
  const account = await connect(page);
  await mountConfirmFrame(page);
  await present(page, tx(limitBuy(account, 2_000_000n)));
  await card(page).getByTestId("card-deny").click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __events: Array<{ event: string; error?: { code: number } }> }).__events.find((e) => e.event === "failed")?.error?.code)).toBe(4001);
  expect(rpc.sent).toHaveLength(0);
});
