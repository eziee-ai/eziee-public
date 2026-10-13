import { expect, test, type Page } from "@playwright/test";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, erc20Abi, parseAbi, parseTransaction, toFunctionSelector, zeroAddress, type Hex, type TransactionSerialized } from "viem";
import manifest from "../../../packages/protocols/registry/rate/manifest.json";
import { AssetGeneratorABI, LadderBuyerABI } from "../../../packages/protocols/src/rate/abis";
import { APP_ORIGIN } from "./ports";
import { mockRpc } from "./rpcMock";
import { dismissOnboardingWhenItBlocks } from "./onboarding";
import { signIn } from "./signIn";
import { MOCK_LAUNCH_COIN } from "../lib/server/mockModel";

/**
 * Rate's launchpad on a MOCKED Monad Testnet, with the scripted model: a launch and a ladder buy, each through the
 * wallet's card. The chain is mocked in the browser (wallet and actions); the server is not asked to read it.
 */
const MONAD = "10143" as const;
const GENERATOR = manifest.contracts[MONAD].assetGenerator.address.toLowerCase() as `0x${string}`;
const LADDER = manifest.contracts[MONAD].ladderBuyer.address.toLowerCase() as `0x${string}`;
const TUSD = manifest.tokens[MONAD].find((t) => t.symbol === "tUSD")!.address.toLowerCase() as `0x${string}`;
const COIN = MOCK_LAUNCH_COIN.toLowerCase() as `0x${string}`;
/** Made up: the coin a mocked launch creates, and the books the mock answers for. */
const NEW_COIN = "0x0000000000000000000000000000000000006001";
const BOOK = "0x0000000000000000000000000000000000003001";
const ESCROW = "0x0000000000000000000000000000000000004001";
const COINS = 10n ** 18n;
const STEPS = [100_000n, 110_000n, 121_000n, 133_100n, 146_410n];
const BOOK_ABI = parseAbi(["function getOrder(bool isBid, uint32 orderId) view returns ((address owner, uint256 price, uint256 depositAmount, uint64 deadline))", "function lmp() view returns (uint256)"]);

async function setUp(page: Page) {
  // This suite runs on Monad: the chat starts there.
  await page.addInitScript(() => localStorage.setItem("wlt.chat-selection", JSON.stringify({ model: "openai/gpt-5.5", protocol: "auto", chainId: 10143 })));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true } });
  await dismissOnboardingWhenItBlocks(page);
  const sel = (signature: string) => toFunctionSelector(signature);
  const rpc = await mockRpc(page.context(), {
    nativeBalance: 10n ** 20n,
    tokenBalances: { [TUSD]: 100_000_000n, [COIN]: 0n },
    tokenMeta: { [TUSD]: { symbol: "tUSD", decimals: 6 }, [COIN]: { symbol: "DEMO", decimals: 18 } },
    simulateOk: [sel("function approve(address,uint256)"), sel("function launch(string,string,uint256,address,uint256,uint8)"), sel("function buy(address,address,uint256,uint256,uint256,address,uint256)")],
    calls: {
      [`${GENERATOR}:${sel("function launchFee()")}`]: encodeFunctionResult({ abi: AssetGeneratorABI, functionName: "launchFee", result: 0n }),
      [`${GENERATOR}:${sel("function quoteOption(address)")}`]: encodeFunctionResult({ abi: AssetGeneratorABI, functionName: "quoteOption", result: { enabled: true, startingMarketCap: 1_000_000_000n, minDevBuy: 1_000_000n, graduationMarketCap: 5_000_000_000n, mode: 0, startingTakerFee: 1_000_000 } }),
      [`${GENERATOR}:${sel("function launches(address)")}`]: (data) => {
        const [coin] = decodeFunctionData({ abi: AssetGeneratorABI, data }).args as [string];
        const record = coin.toLowerCase() === COIN ? ([`0x${"0".repeat(36)}1001`, TUSD, BOOK, 1_790_925_288n, 100, 0, 1_000_000, true, false] as const) : ([zeroAddress, zeroAddress, zeroAddress, 0n, 0, 0, 0, false, false] as const);
        return encodeFunctionResult({ abi: AssetGeneratorABI, functionName: "launches", result: record as never });
      },
      [`${GENERATOR}:${sel("function ladderOf(address)")}`]: encodeFunctionResult({ abi: AssetGeneratorABI, functionName: "ladderOf", result: { pair: BOOK, escrow: ESCROW, restoreBuySpread: 3_000_000, askIds: [1, 2, 3, 4, 5] } }),
      [`${BOOK}:${sel("function getOrder(bool,uint32)")}`]: (data) => {
        const [, id] = decodeFunctionData({ abi: BOOK_ABI, data }).args as [boolean, number];
        return encodeFunctionResult({ abi: BOOK_ABI, functionName: "getOrder", result: { owner: ESCROW, price: STEPS[id - 1]!, depositAmount: 100_000n * COINS, deadline: 0n } });
      },
    },
    receiptLogs: (raw) => {
      const tx = parseTransaction(raw as TransactionSerialized);
      if (tx.to?.toLowerCase() === GENERATOR) {
        return [{ address: GENERATOR, topics: encodeEventTopics({ abi: AssetGeneratorABI, eventName: "Launched", args: { coin: NEW_COIN, creator: `0x${"0".repeat(36)}1001`, pair: BOOK } }) as Hex[], data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [TUSD, 1_000_000_000n * COINS]) }];
      }
      if (tx.to?.toLowerCase() === LADDER && tx.data) {
        const args = decodeFunctionData({ abi: LadderBuyerABI, data: tx.data }).args as readonly unknown[];
        return [{ address: COIN, topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from: BOOK, to: args[5] as `0x${string}` } }) as Hex[], data: encodeAbiParameters([{ type: "uint256" }], [990n * COINS]) }];
      }
      return [];
    },
  });
  await signIn(page);
  await expect(page.getByTestId("credit-balance")).toBeVisible({ timeout: 30_000 });
  expect((await page.request.post("/api/dev/credit", { headers: { origin: APP_ORIGIN } })).ok()).toBe(true);
  return rpc;
}

const send = async (page: Page, text: string) => {
  await page.getByTestId("chat-input").fill(text);
  await page.getByTestId("chat-send").click();
};

test("launching a coin: an exact approval, then a card that names the coin and always asks, and the new address comes back", async ({ page }) => {
  const rpc = await setUp(page);
  await expect(page.getByTestId("protocol-pill")).toContainText("Monad Testnet");
  await send(page, "launch a coin");
  const card = page.frameLocator('iframe[src*="/wallet-frame/confirm"]');

  await expect(page.getByText("Step 1 of 2")).toBeVisible({ timeout: 30_000 });
  await expect(card.getByText(/to spend exactly 5 tUSD/)).toBeVisible();
  await card.getByTestId("card-once").click();

  await expect(card.getByTestId("card-title")).toHaveText("Launch on Rate", { timeout: 30_000 });
  await expect(card.getByTestId("card-spend")).toHaveText("5 tUSD");
  await expect(card.getByTestId("card-detail").first()).toHaveText("a new coin, eziee Demo (DEMO)");
  // A launch is never covered by a rule: there is no "Always allow".
  await expect(card.getByTestId("card-always")).toHaveCount(0);
  await card.getByTestId("card-once").click();

  await expect(page.getByText("Confirmed", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("result-fact").first()).toHaveText(NEW_COIN);
  expect(rpc.sent).toHaveLength(2);
  const launched = parseTransaction(rpc.sent[1]! as TransactionSerialized);
  expect(launched.to?.toLowerCase()).toBe(GENERATOR);
  expect(decodeFunctionData({ abi: AssetGeneratorABI, data: launched.data! }).args).toEqual(["eziee Demo", "DEMO", 1_000_000_000n * COINS, expect.stringMatching(new RegExp(TUSD, "i")), 5_000_000n, 0]);
});

test("buying a launch coin goes through its ladder, with the floor on the card, and the receipt shows the fill", async ({ page }) => {
  const rpc = await setUp(page);
  await send(page, "buy demo");
  const card = page.frameLocator('iframe[src*="/wallet-frame/confirm"]');

  await expect(page.getByText("Step 1 of 2")).toBeVisible({ timeout: 30_000 });
  await expect(card.getByText(/to spend exactly 1 tUSD/)).toBeVisible();
  await card.getByTestId("card-once").click();

  await expect(card.getByTestId("card-title")).toHaveText("Swap on Rate", { timeout: 30_000 });
  await expect(card.getByTestId("card-spend")).toHaveText("1 tUSD");
  await expect(card.getByText("Receives at least")).toBeVisible();
  // The coin is not on the reviewed list, so it is named by address and what it calls itself.
  await expect(card.getByTestId("card-receive")).toContainText("calls itself DEMO");
  await card.getByTestId("card-once").click();

  await expect(page.getByText("Confirmed", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Received 990 DEMO.")).toBeVisible();
  const buy = parseTransaction(rpc.sent[1]! as TransactionSerialized);
  expect(buy.to?.toLowerCase()).toBe(LADDER);
  const { functionName, args } = decodeFunctionData({ abi: LadderBuyerABI, data: buy.data! });
  expect(functionName).toBe("buy");
  expect((args as readonly unknown[]).slice(0, 4)).toEqual([expect.stringMatching(new RegExp(COIN, "i")), expect.stringMatching(new RegExp(TUSD, "i")), 1_000_000n, 100_500n]);
});
