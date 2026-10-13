import { encodeAbiParameters, encodeEventTopics, erc20Abi, type Address, type Hex, type PublicClient } from "viem";
import { beforeEach, describe, expect, it } from "vitest";
import { ensureUser, getAccount, ledgerSum, listLedger } from "@repo/db";
import { createTestDb, type Db } from "@repo/db/testing";
import { creditTokenDeposit, creditUsdcDeposit, resetVerifiedUsdcForTests, tokenToMicrousd, usdcRailConfig, verifyUsdcToken } from "./usdc";

const ALICE = "0x0000000000000000000000000000000000001001" as Address;
const MALLORY = "0x0000000000000000000000000000000000001002" as Address;
const TREASURY = "0x0000000000000000000000000000000000007001" as Address;
const USDC = "0x0000000000000000000000000000000000000201" as Address;
const OTHER_TOKEN = "0x0000000000000000000000000000000000000202" as Address;
const HASH = `0x${"ab".repeat(32)}` as Hex;
const CHAIN = 5042002;
const BLOCK_HASH = `0x${"11".repeat(32)}`;

const transfer = (token: Address, from: Address, to: Address, amount: bigint, logIndex = 0) => ({
  address: token,
  topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from, to } }),
  data: encodeAbiParameters([{ type: "uint256" }], [amount]),
  logIndex,
});

function chain(options: { chainId?: number; canonicalHash?: string; logs?: ReturnType<typeof transfer>[]; status?: "success" | "reverted"; minedAt?: bigint; head?: bigint; missing?: boolean; symbol?: string; decimals?: number; code?: Hex } = {}) {
  return {
    getChainId: async () => options.chainId ?? CHAIN,
    getTransactionReceipt: async () => {
      if (options.missing) throw new Error("not found");
      return { status: options.status ?? "success", blockNumber: options.minedAt ?? 100n, blockHash: BLOCK_HASH, logs: options.logs ?? [transfer(USDC, ALICE, TREASURY, 5_000_000n)] };
    },
    getBlock: async () => ({ hash: options.canonicalHash ?? BLOCK_HASH }),
    getBlockNumber: async () => options.head ?? 110n,
    getCode: async () => options.code ?? "0x6000",
    readContract: async ({ functionName }: { functionName: string }) => (functionName === "symbol" ? (options.symbol ?? "USDC") : (options.decimals ?? 6)),
  } as unknown as PublicClient;
}
const config = { treasury: TREASURY, confirmations: 3, tokens: new Map([[CHAIN, USDC]]), maxPerTopUpMicrousd: 500_000_000n };
const deposit = (db: Db, client: PublicClient, address: Address = ALICE) => creditUsdcDeposit({ db, address, chainId: CHAIN, hash: HASH, client, config, test: true });

let db: Db;
beforeEach(async () => {
  resetVerifiedUsdcForTests();
  db = await createTestDb();
  await ensureUser(db, ALICE);
  await ensureUser(db, MALLORY);
});

describe("usdcRailConfig", () => {
  const mainnet = () => false;
  const testnet = () => true;
  const base = { BILLING_TREASURY_ADDRESS: TREASURY, [`BILLING_USDC_${CHAIN}`]: USDC };

  it("is off without a treasury, and lists only chains whose USDC address is configured and well formed", () => {
    expect(usdcRailConfig({}, [CHAIN], mainnet)).toBeNull();
    expect(usdcRailConfig({ BILLING_TREASURY_ADDRESS: TREASURY }, [CHAIN], mainnet)).toBeNull();
    expect(usdcRailConfig({ BILLING_TREASURY_ADDRESS: TREASURY, [`BILLING_USDC_${CHAIN}`]: "not an address" }, [CHAIN], mainnet)).toBeNull();
    expect(usdcRailConfig({ ...base, BILLING_CONFIRMATIONS: "5" }, [CHAIN, 11155931], mainnet)).toEqual({ treasury: TREASURY, confirmations: 5, tokens: new Map([[CHAIN, USDC]]), maxPerTopUpMicrousd: 500_000_000n });
  });

  it("REFUSES a testnet unless the operator says so in as many words: testnet USDC is free, and the credit it buys spends real model money", () => {
    expect(usdcRailConfig(base, [CHAIN], testnet)).toBeNull();
    expect(usdcRailConfig({ ...base, BILLING_ALLOW_TESTNET_CREDIT: "true" }, [CHAIN], testnet)).toBeNull();
    expect(usdcRailConfig({ ...base, BILLING_ALLOW_TESTNET_CREDIT: "1" }, [CHAIN], testnet)?.tokens.get(CHAIN)).toBe(USDC);
  });

  it("waits twelve blocks unless told otherwise, and takes a cap per top-up", () => {
    expect(usdcRailConfig(base, [CHAIN], mainnet)?.confirmations).toBe(12);
    expect(usdcRailConfig({ ...base, BILLING_MAX_PER_TOPUP_MICROUSD: "25000000" }, [CHAIN], mainnet)?.maxPerTopUpMicrousd).toBe(25_000_000n);
    expect(usdcRailConfig({ ...base, BILLING_MAX_PER_TOPUP_MICROUSD: "lots" }, [CHAIN], mainnet)?.maxPerTopUpMicrousd).toBe(500_000_000n);
  });
});

describe("verifyUsdcToken — a configured address is not believed until the chain agrees", () => {
  it("accepts a contract that has code and calls itself USDC, and reports its decimals", async () => {
    expect(await verifyUsdcToken(chain({ decimals: 6 }), USDC)).toEqual({ decimals: 6 });
  });

  it.each([["an address with no code", { code: "0x" as Hex }], ["a token that is not USDC", { symbol: "USDT" }], ["absurd decimals", { decimals: 40 }]])("refuses %s", async (_name, options) => {
    await expect(verifyUsdcToken(chain(options), USDC)).rejects.toThrow();
  });
});

describe("creditUsdcDeposit", () => {
  it("credits a confirmed transfer of USDC from the account to the treasury, dollar for dollar, marked as test credit on a testnet", async () => {
    expect(await deposit(db, chain())).toEqual({ status: "credited", creditedMicrousd: 5_000_000n });
    const account = await getAccount(db, ALICE);
    expect(account.balance).toBe(5_000_000n);
    expect(await ledgerSum(db, ALICE)).toBe(5_000_000n);
  });

  it("credits the same deposit once, however many times its hash is submitted", async () => {
    await deposit(db, chain());
    expect(await deposit(db, chain())).toEqual({ status: "already-credited" });
    expect((await getAccount(db, ALICE)).balance).toBe(5_000_000n);
  });

  it("scales by the token's own decimals, rounding down", async () => {
    expect(await deposit(db, chain({ decimals: 18, logs: [transfer(USDC, ALICE, TREASURY, 1_234_567_899_999_999_999n)] }))).toEqual({ status: "credited", creditedMicrousd: 1_234_567n });
  });

  it("credits each matching transfer in the transaction, and only those", async () => {
    const logs = [transfer(USDC, ALICE, TREASURY, 1_000_000n, 0), transfer(OTHER_TOKEN, ALICE, TREASURY, 9_000_000n, 1), transfer(USDC, ALICE, MALLORY, 9_000_000n, 2), transfer(USDC, ALICE, TREASURY, 2_000_000n, 3)];
    expect(await deposit(db, chain({ logs }))).toEqual({ status: "credited", creditedMicrousd: 3_000_000n });
  });

  it("waits for the confirmations it was told to, and says how many are left", async () => {
    expect(await deposit(db, chain({ minedAt: 100n, head: 101n }))).toEqual({ status: "pending", confirmations: 2, needed: 3 });
    expect((await getAccount(db, ALICE)).balance).toBe(0n);
    expect(await deposit(db, chain({ missing: true }))).toEqual({ status: "pending", confirmations: 0, needed: 3 });
  });

  it.each([
    ["someone else's deposit claimed by this account", () => deposit(db, chain(), MALLORY)],
    ["a reverted transaction", () => deposit(db, chain({ status: "reverted" }))],
    ["a transfer of another token", () => deposit(db, chain({ logs: [transfer(OTHER_TOKEN, ALICE, TREASURY, 5_000_000n)] }))],
    ["a transfer to somewhere other than the treasury", () => deposit(db, chain({ logs: [transfer(USDC, ALICE, MALLORY, 5_000_000n)] }))],
    ["an amount too small to be a micro-dollar", () => deposit(db, chain({ decimals: 18, logs: [transfer(USDC, ALICE, TREASURY, 999n)] }))],
  ])("credits nothing for %s", async (_name, run) => {
    expect((await run()).status).toBe("rejected");
    expect((await getAccount(db, ALICE)).balance).toBe(0n);
    expect((await getAccount(db, MALLORY)).balance).toBe(0n);
  });

  it("believes a node only about the chain it really is: an endpoint answering for another chain credits nothing", async () => {
    await expect(deposit(db, chain({ chainId: 1 }))).rejects.toThrow(/another chain/);
    expect((await getAccount(db, ALICE)).balance).toBe(0n);
  });

  it("credits nothing while the block it was mined in is not the chain's block at that height any more (a reorg), and records which block it trusted", async () => {
    expect(await deposit(db, chain({ canonicalHash: `0x${"22".repeat(32)}` }))).toEqual({ status: "pending", confirmations: 0, needed: 3 });
    expect((await getAccount(db, ALICE)).balance).toBe(0n);
    await deposit(db, chain());
    const [row] = await listLedger(db, ALICE);
    expect(row).toMatchObject({ kind: "topup_usdc", test: true });
  });

  it("refuses a deposit above the cap instead of minting unbounded credit, and says who can help", async () => {
    const result = await deposit(db, chain({ logs: [transfer(USDC, ALICE, TREASURY, 500_000_001n)] }));
    expect(result).toMatchObject({ status: "rejected", reason: expect.stringContaining("$500.00") });
    expect((await getAccount(db, ALICE)).balance).toBe(0n);
    // Far past what the ledger's 64-bit column could hold: still a refusal, never a database error.
    expect((await deposit(db, chain({ logs: [transfer(USDC, ALICE, TREASURY, 2n ** 200n)] }))).status).toBe("rejected");
  });

  it("holds the cap against the WHOLE transaction: several transfers, each under it, are not a way past it", async () => {
    const logs = [0, 1, 2].map((i) => transfer(USDC, ALICE, TREASURY, 200_000_000n, i));
    expect(await deposit(db, chain({ logs }))).toMatchObject({ status: "rejected", reason: expect.stringContaining("$500.00") });
    expect((await getAccount(db, ALICE)).balance).toBe(0n);
    // Two of them fit, and are credited in full.
    expect(await deposit(db, chain({ logs: logs.slice(0, 2) }))).toEqual({ status: "credited", creditedMicrousd: 400_000_000n });
  });

  it("tells apart a transfer that came from a different address, which is the one case a person can act on", async () => {
    const result = await deposit(db, chain({ logs: [transfer(USDC, MALLORY, TREASURY, 5_000_000n)] }));
    expect(result).toMatchObject({ status: "rejected", reason: expect.stringContaining("different address") });
  });

  it("refuses a chain that has no configured USDC", async () => {
    expect((await creditUsdcDeposit({ db, address: ALICE, chainId: 1, hash: HASH, client: chain(), config, test: false })).status).toBe("rejected");
  });
});

describe("creditTokenDeposit — a token the operator priced", () => {
  // 1 EZT (18 decimals) buys one cent of credit.
  const ezt = { address: OTHER_TOKEN, symbol: "EZT", kind: "topup_token" as const, value: async () => ({ decimals: 18, microusdPerToken: 10_000n }) };
  const pay = (client: PublicClient) => creditTokenDeposit({ db, address: ALICE, chainId: CHAIN, hash: HASH, client, config, token: ezt, test: true });

  it("credits at the fixed price, rounding down, as a token top-up", async () => {
    expect(await pay(chain({ logs: [transfer(OTHER_TOKEN, ALICE, TREASURY, 1_500n * 10n ** 18n)] }))).toEqual({ status: "credited", creditedMicrousd: 15_000_000n });
    const [row] = await listLedger(db, ALICE);
    expect(row).toMatchObject({ kind: "topup_token", test: true });
  });

  it("ignores USDC in the same transaction, and names the token when nothing matches", async () => {
    const result = await pay(chain({ logs: [transfer(USDC, ALICE, TREASURY, 5_000_000n)] }));
    expect(result).toMatchObject({ status: "rejected", reason: expect.stringContaining("EZT") });
  });

  it("credits nothing past the daily limit enforced as it is written, and says what is left", async () => {
    const limit = { since: new Date(Date.now() - 60_000), maxMicrousd: 10_000_000n };
    const result = await creditTokenDeposit({ db, address: ALICE, chainId: CHAIN, hash: HASH, client: chain({ logs: [transfer(OTHER_TOKEN, ALICE, TREASURY, 1_001n * 10n ** 18n)] }), config, token: ezt, test: true, limit });
    expect(result).toMatchObject({ status: "rejected", reason: expect.stringContaining("$10.00 more") });
    expect((await getAccount(db, ALICE)).balance).toBe(0n);
  });

  it("is held to the same cap per top-up", async () => {
    expect((await pay(chain({ logs: [transfer(OTHER_TOKEN, ALICE, TREASURY, 50_001n * 10n ** 18n)] }))).status).toBe("rejected");
  });
});

describe("tokenToMicrousd", () => {
  it("rounds down, so a deposit is never credited for more than it was", () => {
    expect(tokenToMicrousd(1n, 18, 10_000n)).toBe(0n);
    expect(tokenToMicrousd(10n ** 18n, 18, 10_000n)).toBe(10_000n);
    expect(tokenToMicrousd(1_000_000n, 6, 1_000_000n)).toBe(1_000_000n);
  });
});
