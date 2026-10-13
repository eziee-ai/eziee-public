import { decodeEventLog, erc20Abi, getAddress, isAddress, type Address, type Hex, type PublicClient } from "viem";
import { formatUsd } from "@repo/agent/pricing";
import { applyCredit, CreditLimitError, type Db } from "@repo/db";

/**
 * The USDC top-up rail (spec §14.3). A person sends USDC from their own wallet to the treasury; the browser then
 * tells the server the transaction's hash, and the server believes nothing but the chain:
 *
 *   the receipt succeeded · the log is a Transfer FROM the chain's configured USDC contract · its `from` is the
 *   SIGNED-IN account · its `to` is the treasury · it is deep enough.
 *
 * `from` must be the signed-in account, so a hash seen on an explorer cannot be claimed by anyone else. Each
 * matching log is credited once, keyed `<chainId>:<txHash>:<logIndex>`, so a hash submitted twice credits once.
 */

const MICRO_DECIMALS = 6;
/** Three blocks is well short of settled on most chains, and a credit that outlives its deposit is free credit. */
const DEFAULT_CONFIRMATIONS = 12;
/** $500. A ceiling on one top-up, so a mistake in configuration (a token anyone can mint) has a bounded cost. */
const DEFAULT_MAX_PER_TOPUP_MICROUSD = 500_000_000n;
const MAX_DECIMALS = 36;

export interface UsdcRailConfig {
  treasury: Address;
  confirmations: number;
  /** The USDC contract per payment chain. Configured, never hardcoded, and checked against the chain before use. */
  tokens: Map<number, Address>;
  /** The most one deposit may be credited for. Above it nothing is credited and the person is told who to ask. */
  maxPerTopUpMicrousd: bigint;
}

/**
 * From `BILLING_TREASURY_ADDRESS`, `BILLING_USDC_<chainId>`, `BILLING_CONFIRMATIONS` and
 * `BILLING_MAX_PER_TOPUP_MICROUSD`. Null: the rail is off.
 *
 * A TESTNET is refused unless `BILLING_ALLOW_TESTNET_CREDIT=1`. Testnet USDC comes from a faucet, and the credit it
 * buys pays for real model calls: switching that on has to be something an operator did on purpose, not something
 * that follows from filling in an address.
 */
export function usdcRailConfig(env: Record<string, string | undefined>, chainIds: readonly number[], isTestnet: (chainId: number) => boolean): UsdcRailConfig | null {
  const base = treasuryConfig(env);
  if (!base) return null;
  const tokens = new Map<number, Address>();
  for (const chainId of chainIds) {
    const token = env[`BILLING_USDC_${chainId}`];
    if (!token || !isAddress(token)) continue;
    if (isTestnet(chainId) && env.BILLING_ALLOW_TESTNET_CREDIT !== "1") continue;
    tokens.set(chainId, getAddress(token));
  }
  if (tokens.size === 0) return null;
  return { ...base, tokens };
}

/** Where top-ups go, how deep they must be, and the most one may be credited for. Shared by USDC and the operator's tokens. */
export function treasuryConfig(env: Record<string, string | undefined>): Omit<UsdcRailConfig, "tokens"> | null {
  const treasury = env.BILLING_TREASURY_ADDRESS;
  if (!treasury || !isAddress(treasury)) return null;
  const raw = env.BILLING_CONFIRMATIONS;
  const confirmations = raw && /^[0-9]{1,4}$/.test(raw) ? Math.max(1, Number(raw)) : DEFAULT_CONFIRMATIONS;
  const cap = env.BILLING_MAX_PER_TOPUP_MICROUSD;
  const maxPerTopUpMicrousd = cap && /^[1-9][0-9]{0,15}$/.test(cap) ? BigInt(cap) : DEFAULT_MAX_PER_TOPUP_MICROUSD;
  return { treasury: getAddress(treasury), confirmations, maxPerTopUpMicrousd };
}

/** A configured "USDC" address is an operator's claim. The chain has to agree before money is counted against it. */
export async function verifyUsdcToken(client: PublicClient, token: Address): Promise<{ decimals: number }> {
  const code = await client.getCode({ address: token });
  if (!code || code === "0x") throw new Error(`the configured USDC address ${token} has no code on this chain`);
  const [symbol, decimals] = await Promise.all([client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }), client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" })]);
  if (symbol !== "USDC") throw new Error(`the configured USDC address ${token} calls itself "${String(symbol).slice(0, 20)}"`);
  if (!Number.isInteger(Number(decimals)) || Number(decimals) > MAX_DECIMALS) throw new Error(`the configured USDC address ${token} reports ${String(decimals)} decimals`);
  return { decimals: Number(decimals) };
}

const verified = new Map<string, { decimals: number }>();
const failedAt = new Map<string, number>();
const VERIFY_RETRY_MS = 30_000;

/**
 * `verifyUsdcToken`, once per chain and token, and only from a node that IS that chain. A success is kept for the
 * life of the process (a token's decimals do not change); a failure is not retried for half a minute, so a
 * struggling RPC is not asked six questions for every poll of every open page.
 */
export async function verifiedUsdc(client: PublicClient, chainId: number, token: Address, now: () => number = Date.now): Promise<{ decimals: number }> {
  const key = `${chainId}:${token.toLowerCase()}`;
  const known = verified.get(key);
  if (known) return known;
  const failed = failedAt.get(key);
  if (failed !== undefined && now() - failed < VERIFY_RETRY_MS) throw new Error(`the USDC token on chain ${chainId} could not be verified a moment ago`);
  try {
    if ((await client.getChainId()) !== chainId) throw new Error(`the RPC for chain ${chainId} answers as another chain`);
    const result = await verifyUsdcToken(client, token);
    verified.set(key, result);
    failedAt.delete(key);
    return result;
  } catch (error) {
    failedAt.set(key, now());
    throw error;
  }
}

export function resetVerifiedUsdcForTests(): void {
  verified.clear();
  failedAt.clear();
}

/** USDC base units as micro-USD, one dollar per USDC, rounded down: a deposit is never credited for more than it was. */
export function usdcToMicrousd(amount: bigint, decimals: number): bigint {
  return decimals >= MICRO_DECIMALS ? amount / 10n ** BigInt(decimals - MICRO_DECIMALS) : amount * 10n ** BigInt(MICRO_DECIMALS - decimals);
}

/** A token's base units as micro-USD at a fixed price per whole token, rounded down. */
export function tokenToMicrousd(amount: bigint, decimals: number, microusdPerToken: bigint): bigint {
  return (amount * microusdPerToken) / 10n ** BigInt(decimals);
}

/** What a deposit is checked against: the token's contract, how to value it, and the ledger kind it is credited as. */
export interface DepositToken {
  address: Address;
  symbol: string;
  kind: "topup_usdc" | "topup_token";
  /** Asked only once the transaction is deep enough, so a struggling RPC is not asked for every poll. */
  value: () => Promise<{ decimals: number; microusdPerToken: bigint }>;
}

export type UsdcDepositResult =
  | { status: "credited"; creditedMicrousd: bigint }
  | { status: "already-credited" }
  | { status: "pending"; confirmations: number; needed: number }
  | { status: "rejected"; reason: string };

export async function creditUsdcDeposit(input: { db: Db; address: Address; chainId: number; hash: Hex; client: PublicClient; config: UsdcRailConfig; /** Written on the ledger row: credit bought with testnet money is test credit. */ test: boolean }): Promise<UsdcDepositResult> {
  const token = input.config.tokens.get(input.chainId);
  if (!token) return { status: "rejected", reason: "Credit cannot be bought with USDC on that network." };
  return creditTokenDeposit({ ...input, token: { address: token, symbol: "USDC", kind: "topup_usdc", value: async () => ({ decimals: (await verifiedUsdc(input.client, input.chainId, token)).decimals, microusdPerToken: 10n ** BigInt(MICRO_DECIMALS) }) } });
}

/** The same checks as a USDC deposit, for any token the server has a price for. */
export async function creditTokenDeposit(input: { db: Db; address: Address; chainId: number; hash: Hex; client: PublicClient; config: Omit<UsdcRailConfig, "tokens">; token: DepositToken; test: boolean; /** Said instead of the per-top-up cap when a tighter limit set `maxPerTopUpMicrousd`. */ capMessage?: string; /** Enforced again as each log is credited, under the account's lock: the limit read before may be stale. */ limit?: { since: Date; maxMicrousd: bigint } }): Promise<UsdcDepositResult> {
  const { config, client } = input;
  const token = input.token.address;

  // The node must BE the chain it is asked about. A misconfigured endpoint answering for another chain would
  // otherwise "confirm" a transfer of something worthless at the same address.
  if ((await client.getChainId()) !== input.chainId) throw new Error(`the RPC for chain ${input.chainId} answers as another chain`);

  let receipt: Awaited<ReturnType<PublicClient["getTransactionReceipt"]>>;
  try {
    receipt = await client.getTransactionReceipt({ hash: input.hash });
  } catch {
    // Not mined yet, or not visible to this node yet. Either way: not yet.
    return { status: "pending", confirmations: 0, needed: config.confirmations };
  }
  if (receipt.status !== "success") return { status: "rejected", reason: "That transaction failed onchain, so nothing was received." };

  const head = await client.getBlockNumber();
  const confirmations = head >= receipt.blockNumber ? Number(head - receipt.blockNumber) + 1 : 0;
  if (confirmations < config.confirmations) return { status: "pending", confirmations, needed: config.confirmations };

  // The receipt must still be in the chain's block at that height. After a reorg a node can briefly serve a receipt
  // for a block that is no longer canonical; crediting it would be credit with no deposit behind it.
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (block.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()) return { status: "pending", confirmations: 0, needed: config.confirmations };

  const { decimals, microusdPerToken } = await input.token.value();
  const deposits: Array<{ logIndex: number; micro: bigint }> = [];
  let fromElsewhere = false;
  const tooLarge: UsdcDepositResult = input.capMessage ? { status: "rejected", reason: input.capMessage } : { status: "rejected", reason: `That deposit is above the most one top-up can be credited for here, ${formatUsd(config.maxPerTopUpMicrousd)}. Nothing was credited. The funds reached the top-up address; contact the operator of this app with the transaction hash.` };
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== token.toLowerCase()) continue;
    let args: { from: Address; to: Address; value: bigint };
    try {
      const decoded = decodeEventLog({ abi: erc20Abi, eventName: "Transfer", topics: log.topics, data: log.data });
      args = decoded.args as typeof args;
    } catch {
      continue; // another event of the same contract
    }
    if (args.to.toLowerCase() !== config.treasury.toLowerCase()) continue;
    if (args.from.toLowerCase() !== input.address.toLowerCase()) {
      fromElsewhere = true;
      continue;
    }
    const micro = tokenToMicrousd(args.value, decimals, microusdPerToken);
    if (micro > config.maxPerTopUpMicrousd) return tooLarge;
    if (micro > 0n) deposits.push({ logIndex: Number(log.logIndex), micro });
  }
  if (deposits.length === 0) {
    return fromElsewhere
      ? { status: "rejected", reason: "That transfer reached the top-up address from a different address than your wallet (an exchange, a contract wallet, another account). Only a transfer sent directly from the wallet you are signed in with can be credited automatically. Contact the operator of this app with the transaction hash." }
      : { status: "rejected", reason: `That transaction does not send ${input.token.symbol} from your wallet to the top-up address.` };
  }

  // The cap is on the DEPOSIT, which is the whole transaction. A token that emits many transfers, or a wallet that
  // batches them, must not be a way to be credited without limit.
  if (deposits.reduce((sum, deposit) => sum + deposit.micro, 0n) > config.maxPerTopUpMicrousd) return tooLarge;

  let credited = 0n;
  for (const deposit of deposits) {
    let applied: boolean;
    try {
      applied = await applyCredit(input.db, { address: input.address, amount: deposit.micro, kind: input.token.kind, ref: `${input.chainId}:${input.hash.toLowerCase()}:${deposit.logIndex}`, test: input.test, meta: { chainId: input.chainId, hash: input.hash, blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash }, limit: input.limit });
    } catch (error) {
      // Another deposit was credited in the meantime and took what was left of the limit.
      if (!(error instanceof CreditLimitError)) throw error;
      if (credited > 0n) return { status: "credited", creditedMicrousd: credited };
      return { status: "rejected", reason: `That deposit would pass what this account can buy with ${input.token.symbol} today, ${formatUsd(error.leftMicrousd)} more. Nothing was credited. Try a smaller amount tomorrow, or contact the operator of this app with the transaction hash.` };
    }
    if (applied) credited += deposit.micro;
  }
  return credited > 0n ? { status: "credited", creditedMicrousd: credited } : { status: "already-credited" };
}
