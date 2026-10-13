/**
 * Live check of Rate's launchpad on a LOCAL anvil fork of Monad Testnet: the transactions are the ones this
 * package's adapter builds, sent from impersonated wallets, and the wallet's decoders must describe each one.
 *
 *   anvil --fork-url https://testnet-rpc.monad.xyz --port 8548 --auto-impersonate
 *   pnpm --filter @repo/protocols exec tsx scripts/fork-monad-launchpad.ts
 *
 * Nothing reaches the real chain. Not part of any test run.
 */
import { createPublicClient, createWalletClient, custom, erc20Abi, formatUnits, http, parseUnits, type Address, type Hex, type PublicClient } from "viem";
import { createRegistry } from "../src/registry";
import { createRateAdapter, decodeRateLadderApproval, decodeRateWithChain, rateManifest } from "../src/rate";
import type { TxRequest } from "../src/types";

const FORK = process.env.FORK_RPC ?? "http://127.0.0.1:8548";
const MONAD = 10143;
const TUSD = rateManifest.tokens[String(MONAD)]!.find((t) => t.symbol === "tUSD")!.address;
/** Holds tUSD on Monad Testnet; only used, impersonated on the fork, to fund the two test wallets. */
const FUNDER = "0xF8FB4672170607C95663f4Cc674dDb1386b7CfE0" as Address;
/** TITER on Monad, a launch coin still on its ladder (read from the factory in this session). */
const TITER = "0xC1481f94BB3bF29769352dB5c05aD3E6b722583e" as Address;
const CREATOR = "0x00000000000000000000000000000000000c7ea7" as Address;
const BUYER = "0x0000000000000000000000000000000000000b0b" as Address;

const client = createPublicClient({ transport: http(FORK) }) as PublicClient;
const rpc = (method: string, params: unknown[]) => client.request({ method: method as never, params: params as never });
const registry = createRegistry([rateManifest]);
const rate = createRateAdapter();
const fail = (message: string): never => {
  throw new Error(`FAILED: ${message}`);
};

async function send(from: Address, tx: TxRequest): Promise<{ status: string; logs: Array<{ address: Address; topics: Hex[]; data: Hex }> }> {
  // The wallet's view first: every transaction must be described, or the person would see raw calldata.
  const described = registry.decodeApproval(tx) ?? (await decodeRateLadderApproval(tx, client)) ?? registry.decode(tx, from) ?? (await decodeRateWithChain(tx, from, client));
  if (!described) fail(`the wallet could not describe a transaction to ${tx.to}`);
  const label = "action" in described! ? `${described.action} (${described.contract})` : `approve ${described!.spenderKey}`;
  const wallet = createWalletClient({ account: from, transport: custom({ request: (args) => client.request(args as never) }) });
  const hash = await wallet.sendTransaction({ account: from, chain: null, to: tx.to, data: tx.data, value: tx.value });
  const receipt = await client.waitForTransactionReceipt({ hash });
  console.log(`  ${label}: ${receipt.status}`);
  if (receipt.status !== "success") fail(`${label} reverted`);
  return { status: receipt.status, logs: receipt.logs.map((l) => ({ address: l.address, topics: l.topics as Hex[], data: l.data })) };
}

async function run(from: Address, actionName: "launch" | "swap", input: unknown) {
  const action = rate.actions[actionName]!;
  const ctx = { chainId: MONAD, account: from, client };
  const intent = action.intent.parse(input);
  const txs = await action.build(intent, ctx);
  let last: Awaited<ReturnType<typeof send>> = { status: "", logs: [] };
  for (const tx of txs) last = await send(from, tx);
  const outcome = await action.outcome!(intent, last.logs, ctx);
  console.log(`  outcome: ${outcome.filled ? "filled" : "NOT filled"}: ${outcome.message}${outcome.facts ? ` ${JSON.stringify(outcome.facts)}` : ""}`);
  return outcome;
}

const balance = (token: Address, who: Address) => client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] });

async function main() {
  if ((await client.getChainId()) !== MONAD) fail(`${FORK} is not a fork of Monad Testnet`);
  for (const who of [CREATOR, BUYER]) {
    await rpc("anvil_setBalance", [who, "0x56BC75E2D63100000"]);
    const funder = createWalletClient({ account: FUNDER, transport: custom({ request: (args) => client.request(args as never) }) });
    await client.waitForTransactionReceipt({ hash: await funder.writeContract({ account: FUNDER, chain: null, address: TUSD, abi: erc20Abi, functionName: "transfer", args: [who, parseUnits("50", 6)] }) });
  }

  console.log("1. launch FORK with a 5 tUSD dev buy");
  const launched = await run(CREATOR, "launch", { name: "Fork Demo", symbol: "fork", devBuy: "5", quote: TUSD });
  const coin = (launched.facts?.Coin ?? fail("no coin address in the outcome")) as Address;

  console.log("2. read it back from the chain");
  const info = (await rate.reads.launchInfo!.run({ coin }, { chainId: MONAD, client })) as { onLadder: boolean; ladder: unknown[] };
  if (!info.onLadder || info.ladder.length !== 5) fail("the new coin is not on a five-step ladder");
  const markets = (await rate.reads.markets!.run({}, { chainId: MONAD, client })) as { markets: Array<{ market: string; launchCoinOnLadder: boolean }> };
  console.log(`  markets read: ${markets.markets.map((m) => `${m.market}${m.launchCoinOnLadder ? " (ladder)" : ""}`).join(", ")}`);
  const quote = (await rate.reads.quote!.run({ tokenIn: TUSD, tokenOut: coin, amountIn: "1" }, { chainId: MONAD, client })) as { estimatedOut: string; venue?: string };
  console.log(`  quote: 1 tUSD -> ${quote.estimatedOut} FORK on the ${quote.venue}`);

  console.log("3. another wallet buys FORK on its ladder with 1 tUSD");
  const before = await balance(coin, BUYER);
  const bought = await run(BUYER, "swap", { tokenIn: TUSD, tokenOut: coin, amountIn: "1", maxSlippageBps: 50, expectedOut: quote.estimatedOut });
  const got = (await balance(coin, BUYER)) - before;
  if (!bought.filled || got <= 0n) fail("the ladder buy did not deliver coins");
  console.log(`  buyer received ${formatUnits(got, 18)} FORK`);

  console.log("4. buy TITER on its ladder, then sell half back into its bids");
  await run(BUYER, "swap", { tokenIn: TUSD, tokenOut: TITER, amountIn: "1", maxSlippageBps: 50 });
  const titer = await balance(TITER, BUYER);
  const sold = await run(BUYER, "swap", { tokenIn: TITER, tokenOut: TUSD, amountIn: formatUnits(titer / 2n, 18), maxSlippageBps: 100 });
  console.log(`  sell ${sold.filled ? "filled" : "did not fill"}; buyer now holds ${formatUnits(await balance(TITER, BUYER), 18)} TITER`);

  console.log("ALL CHECKS PASSED");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
