import { expect, test, type Page } from "@playwright/test";
import { APP_ORIGIN } from "./ports";
import { decodeFunctionData, encodeAbiParameters, erc20Abi, parseAbi, parseTransaction, recoverTransactionAddress, toFunctionSelector, zeroAddress, type Hex, type TransactionSerialized, encodeEventTopics } from "viem";
import manifest from "../../../packages/protocols/registry/rate/manifest.json";
import { mockRpc } from "./rpcMock";
import { dismissOnboardingWhenItBlocks } from "./onboarding";
import { holdChatStream, releaseChatStream } from "./streamGate";
import { signIn } from "./signIn";
import { startOnArc } from "./startOnArc";
import { mockRateGateway } from "./gatewayMock";

/**
 * The chat, end to end, with a SCRIPTED model (the server runs with E2E_TEST_HOOKS=1)
 * and a mocked chain. Everything between them is real: sign-in, metering, tools, the
 * action runner, the wallet frame's decode and its permission card.
 */

const ENGINE = manifest.contracts["5042002"].matchingEngine.address.toLowerCase();
const [USDC, EURC] = manifest.tokens["5042002"].map((t) => t.address.toLowerCase()) as [string, string];
const LIMIT_BUY = "function limitBuy((address base, address quote, uint256 price, uint256 amount, bool isMaker, uint32 n, address recipient) params)";
const ROUTER = manifest.contracts["5042002"].swapRouter.address.toLowerCase();
const FACTORY = manifest.contracts["5042002"].bandPoolFactory.address.toLowerCase();
const GET_POOL = "function getPool(address,address)";
const SWAP = "function swap(address pool, uint256 amountIn, bool quoteToBase, address recipient, uint256 minAmountOut)";
/** A made-up pool address. It is a pool only because the mocked factory says so, which is the point of the decode.  */
const POOL = "0x0000000000000000000000000000000000005001";

async function addPasskeyAuthenticator(page: Page) {
  await startOnArc(page);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true },
  });
  await dismissOnboardingWhenItBlocks(page);
}

function chain(page: Page) {
  return mockRpc(page.context(), {
    nativeBalance: 10n ** 20n,
    tokenBalances: { [USDC]: 100_000_000n, [EURC]: 0n },
    tokenMeta: { [USDC]: { symbol: "USDC", decimals: 6 }, [EURC]: { symbol: "EURC", decimals: 6 } },
    simulateOk: [toFunctionSelector("function approve(address,uint256)"), toFunctionSelector(LIMIT_BUY)],
  });
}

/** Connect; sign-in then happens by itself, with no prompt, because the frame recognises the template. */
async function connectAndSignIn(page: Page) {
  await signIn(page);
  await expect(page.getByTestId("credit-balance")).toBeVisible({ timeout: 30_000 });
}

const send = async (page: Page, text: string) => {
  await page.getByTestId("chat-input").fill(text);
  await page.getByTestId("chat-send").click();
};

test("with no wallet the chat is not shown: sign-in comes first, then the chat it was asked for", async ({ page }) => {
  await addPasskeyAuthenticator(page);
  await chain(page);
  await page.goto("/home");
  await expect(page).toHaveURL(/\/login\?next=%2Fhome$/, { timeout: 30_000 });
  await expect(page.getByTestId("chat-input")).toHaveCount(0);
  await page.getByTestId("login-passkey").click();
  await expect(page).toHaveURL(/\/home$/, { timeout: 30_000 });
  await expect(page.getByTestId("chat-input")).toBeVisible();
});

test("a new account has no credit: the message is refused before any model call, and says so", async ({ page }) => {
  await addPasskeyAuthenticator(page);
  await chain(page);
  await connectAndSignIn(page);
  await expect(page.getByTestId("credit-balance")).toHaveText("$0.0000");
  await send(page, "hello");
  await expect(page.getByText("Add credit to continue")).toBeVisible();
  await expect(page.getByText("was not sent to the model")).toBeVisible();
  await expect(page.getByTestId("message-assistant")).toHaveCount(0);
});

test("with credit: a reply streams, is charged, is saved, and reopens from the sidebar", async ({ page }) => {
  await addPasskeyAuthenticator(page);
  await chain(page);
  await connectAndSignIn(page);
  expect((await page.request.post("/api/dev/credit", { headers: { origin: APP_ORIGIN } })).ok()).toBe(true);

  await send(page, "hello there");
  await expect(page.getByTestId("message-assistant")).toContainText("Hello from the scripted model.");
  // 1200 in × 3 + 80 out × 15 = 4800 micro-USD, +30% = 6240 → $0.0062
  await expect(page.getByTestId("message-cost")).toContainText("$0.0062");
  await expect(page.getByTestId("credit-balance")).toHaveText("$0.99");
  await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}$/);

  await page.getByTestId("new-chat").click();
  await expect(page.getByRole("heading", { name: /Your intent\.\s*Into action\./ })).toBeVisible();
  await page.getByRole("link", { name: "hello there" }).click();
  await expect(page.getByTestId("message-user")).toContainText("hello there");
  await expect(page.getByTestId("message-assistant")).toContainText("Hello from the scripted model.");
});

test("a reply says what it used, and the chip beside the prompt sums the chat and shows the last reply's context", async ({ page }) => {
  await addPasskeyAuthenticator(page);
  await chain(page);
  await connectAndSignIn(page);
  await page.request.post("/api/dev/credit", { headers: { origin: APP_ORIGIN } });
  await expect(page.getByTestId("usage-chip")).toHaveCount(0);

  await send(page, "hello there");
  // The scripted model reports 1200 tokens in and 80 out.
  await expect(page.getByTestId("message-cost")).toHaveText("kimi-k3 · 1.2k in · 80 out · $0.0062");
  const chip = page.getByTestId("usage-chip");
  await expect(chip).toHaveText("1.3k tokens · $0.0062");

  await chip.click();
  const panel = page.getByRole("dialog", { name: "Usage in this chat" });
  await expect(panel.getByTestId("usage-replies")).toHaveText("1");
  await expect(panel.getByTestId("usage-context")).toHaveText(/^[\d.]+k? of 256\.0k$/);
  await expect(panel.getByText("no longer sent to the model")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(chip).toBeFocused();
});

test("while a reply is pending, dots say so; while it streams, a cursor follows the text; both go when it ends", async ({ page }) => {
  await holdChatStream(page);
  await addPasskeyAuthenticator(page);
  await chain(page);
  await connectAndSignIn(page);
  await page.request.post("/api/dev/credit", { headers: { origin: APP_ORIGIN } });

  await send(page, "hello there");
  await expect(page.getByTestId("pending-dots")).toBeVisible();
  await expect(page.getByTestId("pending-dots")).toHaveAttribute("aria-hidden", "true");
  await expect(page.getByRole("status").filter({ hasText: "Thinking" })).toHaveCount(1);
  await expect(page.getByTestId("streaming-cursor")).toHaveCount(0);

  await releaseChatStream(page);
  await expect(page.getByTestId("message-assistant")).toContainText("Hello from the scripted model.");
  await expect(page.getByTestId("streaming-cursor")).toBeVisible();
  await expect(page.getByTestId("pending-dots")).toHaveCount(0);
  await expect(page.getByTestId("chat-status")).toBeEmpty();

  await releaseChatStream(page);
  await expect(page.getByTestId("message-cost")).toBeVisible();
  await expect(page.getByTestId("streaming-cursor")).toHaveCount(0);
});

test("a new reply rises in, and under reduced motion nothing animates", async ({ page }) => {
  await addPasskeyAuthenticator(page);
  await chain(page);
  await connectAndSignIn(page);
  await page.request.post("/api/dev/credit", { headers: { origin: APP_ORIGIN } });
  await send(page, "hello there");
  const reply = page.getByTestId("message-assistant");
  await expect(reply).toContainText("Hello from the scripted model.");
  await expect(reply).toHaveClass(/\brise-in\b/);
  const animation = () => reply.evaluate((node) => getComputedStyle(node).animationName);

  // First the animation is really there, so the reduced-motion check below cannot pass by accident.
  expect(await animation()).toBe("rise-in");
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await animation()).toBe("none");
});

test("a server tool runs with the session's wallet and its result comes back to the model", async ({ page }) => {
  await addPasskeyAuthenticator(page);
  await chain(page);
  await connectAndSignIn(page);
  await page.request.post("/api/dev/credit", { headers: { origin: APP_ORIGIN } });
  await send(page, "what are my balances?");
  await expect(page.getByText("Rate", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("balances", { exact: true })).toBeVisible();
  await expect(page.getByTestId("message-assistant").last()).toContainText("Here is what I found.");
});

test("an action: the model asks, the wallet describes and asks the person twice (approval, then order), and the signed order is exactly the intent", async ({ page }) => {
  await addPasskeyAuthenticator(page);
  const rpc = await chain(page);
  await connectAndSignIn(page);
  await page.request.post("/api/dev/credit", { headers: { origin: APP_ORIGIN } });

  await send(page, "place order");
  const card = page.frameLocator('iframe[src*="/wallet-frame/confirm"]');

  // Step 1: an approval, which the wallet describes from the calldata and never offers a rule for.
  await expect(page.getByText("Step 1 of 2")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("step-progress")).toHaveAttribute("aria-valuetext", "Step 3 of 4: approve");
  await expect(card.getByTestId("card-title")).toHaveCount(0);
  await expect(card.getByText(/to spend exactly 2 USDC/)).toBeVisible();
  await card.getByTestId("card-once").click();

  // Step 2: the order itself, decoded by the wallet.
  await expect(card.getByTestId("card-title")).toHaveText("Place order on Rate", { timeout: 30_000 });
  await expect(card.getByTestId("card-spend")).toHaveText("2 USDC");
  await card.getByTestId("card-once").click();

  await expect(page.getByText("Confirmed", { exact: true })).toBeVisible({ timeout: 30_000 });
  // Confirmed in this view, so the check draws itself.
  await expect(page.getByTestId("check-draw")).toBeVisible();
  await expect(page.getByTestId("check-draw")).toHaveClass(/check-draw-animate/);
  // The part rose in once, when it appeared; the card inside it did not rise again when it became the result.
  await expect(page.getByTestId("tool-part")).toHaveClass(/\brise-in\b/);
  await expect(page.getByTestId("tool-part").locator(".rise-in")).toHaveCount(0);
  await expect(page.getByTestId("message-assistant").last()).toContainText("Done. That is confirmed onchain.");

  expect(rpc.sent).toHaveLength(2);
  const approve = parseTransaction(rpc.sent[0]! as TransactionSerialized);
  expect(approve.to?.toLowerCase()).toBe(USDC);
  expect(decodeFunctionData({ abi: erc20Abi, data: approve.data! }).args?.map(String).map((v) => v.toLowerCase())).toEqual([ENGINE, "2000000"]);
  const order = parseTransaction(rpc.sent[1]! as TransactionSerialized);
  expect(order.to?.toLowerCase()).toBe(ENGINE);
  const [params] = decodeFunctionData({ abi: parseAbi([LIMIT_BUY]), data: order.data! }).args as unknown as [{ base: string; quote: string; price: bigint; amount: bigint }];
  expect([params.base.toLowerCase(), params.quote.toLowerCase(), params.price, params.amount]).toEqual([EURC, USDC, 101_000_000n, 2_000_000n]);

  // Back to the chat without a reload: the finished run is still in memory, but this view never watched it run.
  await page.getByTestId("new-chat").click();
  await page.getByRole("link", { name: "place order" }).click();
  await expect(page.getByTestId("check-draw")).toBeVisible();
  await expect(page.getByTestId("check-draw")).not.toHaveClass(/check-draw-animate/);
  await expect(page.locator(".rise-in")).toHaveCount(0);

  // And after a reload, history is simply shown: nothing rises in and the check is already drawn.
  await page.reload();
  await expect(page.getByText("Confirmed", { exact: true })).toBeVisible();
  await expect(page.getByTestId("tool-part")).not.toHaveClass(/\brise-in\b/);
  await expect(page.locator(".rise-in")).toHaveCount(0);
  await expect(page.getByTestId("check-draw")).not.toHaveClass(/check-draw-animate/);
});

test("adding liquidity: two exact approvals, then a deposit whose card shows BOTH tokens and offers no rule", async ({ page }) => {
  const MANAGER = manifest.contracts["5042002"].positionManager.address.toLowerCase();
  const FACTORY = manifest.contracts["5042002"].bandPoolFactory.address.toLowerCase();
  const POOL = "0x0000000000000000000000000000000000005001";
  const ADD = "function mint((address pool, uint8[] bands, uint256[] baseAmounts, uint256[] quoteAmounts, uint128[] minShares, address recipient, uint256 deadline) p)";
  const sel = (signature: string) => toFunctionSelector(signature);
  const word = (types: string[], values: unknown[]): Hex => encodeAbiParameters(types.map((type) => ({ type })), values);

  await addPasskeyAuthenticator(page);
  const rpc = await mockRpc(page.context(), {
    nativeBalance: 10n ** 20n,
    tokenBalances: { [USDC]: 100_000_000n, [EURC]: 100_000_000n },
    tokenMeta: { [USDC]: { symbol: "USDC", decimals: 6 }, [EURC]: { symbol: "EURC", decimals: 6 } },
    simulateOk: [sel("function approve(address,uint256)"), sel(ADD)],
    calls: {
      // The factory vouches for POOL; the pool says it is EURC/USDC with one open, empty band.
      [`${FACTORY}:${sel("function getPool(address,address)")}`]: word(["address"], [POOL]),
      [`${POOL}:${sel("function base()")}`]: word(["address"], [EURC]),
      [`${POOL}:${sel("function quote()")}`]: word(["address"], [USDC]),
      [`${POOL}:${sel("function bandCount()")}`]: word(["uint256"], [1n]),
      [`${POOL}:${sel("function bands(uint8)")}`]: word(["uint32", "uint256", "uint256", "uint256", "bool"], [10, 0n, 0n, 0n, true]),
      [`${POOL}:${sel("function bandReserves(uint8)")}`]: word(["uint256", "uint256"], [0n, 0n]),
    },
  });
  await connectAndSignIn(page);
  await page.request.post("/api/dev/credit", { headers: { origin: APP_ORIGIN } });

  await send(page, "add liquidity");
  const card = page.frameLocator('iframe[src*="/wallet-frame/confirm"]');
  await expect(page.getByText("Step 1 of 3")).toBeVisible({ timeout: 30_000 });
  await expect(card.getByText(/to spend exactly 1 EURC/)).toBeVisible();
  await card.getByTestId("card-once").click();
  await expect(page.getByText("Step 2 of 3")).toBeVisible({ timeout: 30_000 });
  await expect(card.getByText(/to spend exactly 2 USDC/)).toBeVisible();
  await card.getByTestId("card-once").click();

  await expect(card.getByTestId("card-title")).toHaveText("Add liquidity on Rate", { timeout: 30_000 });
  await expect(card.getByTestId("card-spend")).toHaveText(["1 EURC", "2 USDC"]);
  // Which pool and which band: a deposit the person cannot place is one they cannot judge.
  await expect(card.getByTestId("card-venue")).toContainText(`${POOL} · band 0`);
  await expect(card.getByText("spends more than one token")).toBeVisible();
  await expect(card.getByTestId("card-always")).toHaveCount(0);
  await card.getByTestId("card-once").click();

  await expect(page.getByText("Confirmed", { exact: true })).toBeVisible({ timeout: 30_000 });
  expect(rpc.sent).toHaveLength(3);
  const deposit = parseTransaction(rpc.sent[2]! as TransactionSerialized);
  expect(deposit.to?.toLowerCase()).toBe(MANAGER);
  // A new position, minted to the wallet that signed. An empty band mints one share per base unit: the floor is 99.5% of that.
  const [mint] = decodeFunctionData({ abi: parseAbi([ADD]), data: deposit.data! }).args as unknown as [{ pool: string; bands: number[]; baseAmounts: bigint[]; quoteAmounts: bigint[]; minShares: bigint[]; recipient: string }];
  const signer = await recoverTransactionAddress({ serializedTransaction: rpc.sent[2]! as TransactionSerialized });
  expect({ ...mint, pool: mint.pool.toLowerCase(), recipient: mint.recipient.toLowerCase() }).toMatchObject({ pool: POOL, bands: [0], baseAmounts: [1_000_000n], quoteAmounts: [2_000_000n], minShares: [995_000n], recipient: signer.toLowerCase() });
});

/**
 * A chain with ONE genuine Rate pool: base EURC, quote USDC. `getPool` is order-sensitive, as the real
 * factory's CREATE2 salt makes it: only (EURC, USDC) names a pool. That is what forces the swap's
 * direction flag to be read rather than guessed, and what lets the wallet prove POOL is a pool at all.
 */
function swapChain(page: Page) {
  const sel = (signature: string) => toFunctionSelector(signature);
  const word = (types: string[], values: unknown[]): Hex => encodeAbiParameters(types.map((type) => ({ type })), values);
  return mockRpc(page.context(), {
    nativeBalance: 10n ** 20n,
    tokenBalances: { [USDC]: 100_000_000n, [EURC]: 0n },
    tokenMeta: { [USDC]: { symbol: "USDC", decimals: 6 }, [EURC]: { symbol: "EURC", decimals: 6 } },
    simulateOk: [sel("function approve(address,uint256)"), sel(SWAP)],
    // The pool pays the swap's recipient its floor: the receipt shows the fill, so the action can say it was done.
    receiptLogs: (raw) => {
      const tx = parseTransaction(raw as TransactionSerialized);
      if (tx.to?.toLowerCase() !== ROUTER || !tx.data) return [];
      const [, , , recipient, minOut] = decodeFunctionData({ abi: parseAbi([SWAP]), data: tx.data }).args as [string, bigint, boolean, `0x${string}`, bigint];
      return [{ address: EURC as `0x${string}`, topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from: POOL as `0x${string}`, to: recipient } }) as `0x${string}`[], data: encodeAbiParameters([{ type: "uint256" }], [minOut]) }];
    },
    calls: {
      [`${FACTORY}:${sel(GET_POOL)}`]: (data) => {
        const [a, b] = (decodeFunctionData({ abi: parseAbi([GET_POOL]), data }).args as [string, string]).map((v) => v.toLowerCase());
        return word(["address"], [a === EURC && b === USDC ? POOL : zeroAddress]);
      },
      [`${POOL}:${sel("function base()")}`]: word(["address"], [EURC]),
      [`${POOL}:${sel("function quote()")}`]: word(["address"], [USDC]),
    },
  });
}

/** 50 USDC in, 49.5 EURC out at the moment of building. Everything else is what the gateway's schema requires. */
const fresh = (estimatedOut: number) => ({ available: true as const, path: [USDC, EURC], amountIn: 50, estimatedOut, leftoverIn: 0, priceImpactPct: 0.1, hops: [{ pair: "EURC/USDC", side: "buyBase", mktPrice: 1, avgPrice: 1 }] });

test("a swap: a fresh quote sets the floor, the approval and the router call are exact, and the wallet may cap what goes in", async ({ page }) => {
  await addPasskeyAuthenticator(page);
  const rpc = await swapChain(page);
  const gateway = await mockRateGateway(page.context(), fresh(49.5));
  await connectAndSignIn(page);
  await page.request.post("/api/dev/credit", { headers: { origin: APP_ORIGIN } });

  await send(page, "swap 50 usdc for eurc");
  const card = page.frameLocator('iframe[src*="/wallet-frame/confirm"]');

  // Step 1: an approval for exactly what the swap spends, and no more.
  await expect(page.getByText("Step 1 of 2")).toBeVisible({ timeout: 30_000 });
  await expect(card.getByText(/to spend exactly 50 USDC/)).toBeVisible();
  await card.getByTestId("card-once").click();

  // Step 2: the swap, described by the wallet from the pool the factory vouched for — not from the chat.
  await expect(card.getByTestId("card-title")).toHaveText("Swap on Rate", { timeout: 30_000 });
  await expect(card.getByTestId("card-spend")).toHaveText("50 USDC");
  // 49.5 EURC less the 0.50% allowed. The card promises the FLOOR, never the estimate.
  await expect(card.getByText("Receives at least")).toBeVisible();
  await expect(card.getByTestId("card-receive")).toHaveText("49.2525 EURC");

  // One token in, one out, both listed: a rule may be offered, prefilled with what is on screen and nothing wider.
  await card.getByTestId("card-always").click();
  await expect(card.getByTestId("scope-per-tx")).toHaveValue("50");
  await expect(card.getByTestId("scope-per-day")).toHaveValue("200");
  await card.getByTestId("scope-save").click();

  await expect(page.getByText("Confirmed", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("message-assistant").last()).toContainText("Done. That is confirmed onchain.");

  // The route was really asked for, once, for this amount on this network.
  expect(gateway.asked).toHaveLength(1);
  const query = new URLSearchParams(gateway.asked[0]!);
  expect([query.get("network"), query.get("amountIn"), query.get("tokenIn")?.toLowerCase(), query.get("tokenOut")?.toLowerCase()]).toEqual(["Arc Testnet", "50", USDC, EURC]);

  expect(rpc.sent).toHaveLength(2);
  const approve = parseTransaction(rpc.sent[0]! as TransactionSerialized);
  expect(approve.to?.toLowerCase()).toBe(USDC);
  expect(decodeFunctionData({ abi: erc20Abi, data: approve.data! }).args?.map(String).map((v) => v.toLowerCase())).toEqual([ROUTER, "50000000"]);

  const swap = parseTransaction(rpc.sent[1]! as TransactionSerialized);
  expect(swap.to?.toLowerCase()).toBe(ROUTER);
  const [pool, amountIn, quoteToBase, recipient, minOut] = decodeFunctionData({ abi: parseAbi([SWAP]), data: swap.data! }).args as [string, bigint, boolean, string, bigint];
  // quoteToBase is TRUE because USDC is this pool's QUOTE: the direction was read from the chain, not defaulted.
  expect([pool.toLowerCase(), amountIn, quoteToBase, minOut]).toEqual([POOL, 50_000_000n, true, 49_252_500n]);
  // What comes back goes to the wallet that signed, and nowhere else.
  const signer = await recoverTransactionAddress({ serializedTransaction: rpc.sent[1]! as TransactionSerialized });
  expect(recipient.toLowerCase()).toBe(signer.toLowerCase());
});

test("a swap priced from a stale quote is refused before the wallet is asked: nothing is signed", async ({ page }) => {
  await addPasskeyAuthenticator(page);
  const rpc = await swapChain(page);
  // The model asks for a swap it believes returns 50 EURC. The fresh route says 49.5, past the 0.50% it allowed.
  const gateway = await mockRateGateway(page.context(), fresh(49.5));
  await connectAndSignIn(page);
  await page.request.post("/api/dev/credit", { headers: { origin: APP_ORIGIN } });

  await send(page, "swap at yesterday's price");
  await expect(page.getByText(/The price moved/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Not sent")).toBeVisible();
  // Refused by the FRESH quote, not by a dead gateway: it answered, and the wallet was never shown anything.
  expect(gateway.asked).toHaveLength(1);
  await expect(page.locator('iframe[src*="/wallet-frame/confirm"]')).toHaveCount(0);
  expect(rpc.sent).toHaveLength(0);
});

test("denying in the wallet stops the action: nothing is signed and the model does not retry", async ({ page }) => {
  await addPasskeyAuthenticator(page);
  const rpc = await chain(page);
  await connectAndSignIn(page);
  await page.request.post("/api/dev/credit", { headers: { origin: APP_ORIGIN } });
  await send(page, "place order");
  await page.frameLocator('iframe[src*="/wallet-frame/confirm"]').getByTestId("card-deny").click({ timeout: 30_000 });
  await expect(page.getByText("You denied this in your wallet. Nothing was signed.")).toBeVisible();
  await expect(page.getByTestId("check-draw")).toHaveCount(0);
  await expect(page.getByTestId("message-assistant").last()).toContainText("I will not try again unless you ask.");
  expect(rpc.sent).toHaveLength(0);
});

test("text the model writes cannot load an image, and a link asks before it opens", async ({ page }) => {
  await addPasskeyAuthenticator(page);
  await chain(page);
  const outbound: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("collect.example")) outbound.push(request.url());
  });
  await connectAndSignIn(page);
  await page.request.post("/api/dev/credit", { headers: { origin: APP_ORIGIN } });
  await send(page, "show me a picture");
  const reply = page.getByTestId("message-assistant");
  await expect(reply).toContainText("[image not shown: chart]");
  await expect(reply.locator("img")).toHaveCount(0);
  expect(outbound).toEqual([]);

  // The link's text says "the docs"; the person is shown where it really goes before anything opens.
  await reply.getByText("the docs").click();
  await expect(page.getByText("https://example.com/docs")).toBeVisible();
});

test("an action can be cancelled from the chat when the wallet's card is not answered: nothing is signed", async ({ page }) => {
  await addPasskeyAuthenticator(page);
  const rpc = await chain(page);
  await connectAndSignIn(page);
  await page.request.post("/api/dev/credit", { headers: { origin: APP_ORIGIN } });
  await send(page, "place order");
  await expect(page.getByTestId("chat-disabled-reason")).toHaveText("Finish or cancel the action above first.", { timeout: 30_000 });
  await page.getByTestId("action-cancel").click();
  await expect(page.getByText("You denied this in your wallet. Nothing was signed.")).toBeVisible();
  await expect(page.getByTestId("chat-disabled-reason")).toHaveCount(0);
  expect(rpc.sent).toHaveLength(0);
});

test("a saved chat reopens with the protocol it was last sent with, not the browser's latest choice", async ({ page }) => {
  await addPasskeyAuthenticator(page);
  await chain(page);
  await connectAndSignIn(page);
  await page.request.post("/api/dev/credit", { headers: { origin: APP_ORIGIN } });
  await page.getByTestId("protocol-pill").click();
  await page.getByTestId("protocol-rate").click();
  await send(page, "first chat on rate");
  await expect(page.getByTestId("message-assistant")).toContainText("Hello from the scripted model.");

  await page.getByTestId("new-chat").click();
  await page.getByTestId("protocol-pill").click();
  await page.getByTestId("protocol-auto").click();
  await expect(page.getByTestId("protocol-pill")).toContainText("Auto");

  await page.getByRole("link", { name: "first chat on rate" }).click();
  await expect(page.getByTestId("message-user")).toContainText("first chat on rate");
  await expect(page.getByTestId("protocol-pill")).toContainText("Rate ·");
});

test("the pickers work from the keyboard: arrows move, Escape closes and returns focus", async ({ page }) => {
  await addPasskeyAuthenticator(page);
  await chain(page);
  await connectAndSignIn(page);
  await page.getByTestId("model-pill").focus();
  await page.keyboard.press("Enter");
  const first = page.getByRole("radio", { name: /GPT-5\.5/ }).first();
  await expect(first).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(first).not.toBeFocused();
  await expect(page.locator('[role="radio"]:focus')).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("model-pill")).toBeFocused();
});

test("on a phone the menu is a real modal: focus goes in, stays in, and comes back", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto("/deposit");
  const menu = page.getByRole("button", { name: "Open menu" });
  await menu.click();
  const drawer = page.getByRole("dialog", { name: "Menu" });
  await expect(drawer).toBeVisible();
  expect(await drawer.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  for (let i = 0; i < 25; i++) await page.keyboard.press("Tab");
  expect(await drawer.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(menu).toBeFocused();
});

test("when the model opens the deposit screen, the person is taken there and NO follow-up request is billed behind them", async ({ page }) => {
  await addPasskeyAuthenticator(page);
  await chain(page);
  await connectAndSignIn(page);
  await page.request.post("/api/dev/credit", { headers: { origin: APP_ORIGIN } });
  let chatRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/chat") chatRequests += 1;
  });
  await send(page, "fund my wallet");
  await expect(page).toHaveURL(/\/deposit$/, { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Deposit", level: 1 })).toBeVisible();
  await page.waitForTimeout(1500); // long enough for an automatic follow-up to have been sent, if one were coming
  expect(chatRequests).toBe(1);
  await expect(page.getByTestId("credit-balance")).toHaveText("$0.99");
});

test("the model and protocol pills change what is sent", async ({ page }) => {
  await addPasskeyAuthenticator(page);
  await chain(page);
  await connectAndSignIn(page);
  await page.getByTestId("protocol-pill").click();
  await page.getByTestId("protocol-rate").click();
  await expect(page.getByTestId("protocol-pill")).toContainText("Rate · Arc Testnet");
  await page.getByTestId("protocol-pill").click();
  await page.getByTestId("chat-network-11155931").click();
  await expect(page.getByTestId("protocol-pill")).toContainText("RISE Testnet");
  await page.keyboard.press("Escape");
  await page.getByTestId("model-pill").click();
  await expect(page.getByRole("radio", { name: /Kimi K3 Fast/ })).toBeVisible();
});
