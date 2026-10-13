import { erc20Abi, getAddress, type Address, type PublicClient } from "viem";
import { creditedSince, listPaymentTokens, type Db, type PaymentToken } from "@repo/db";
import { appChains } from "@/lib/chains";
import { treasuryConfig } from "./usdc";

const MAX_DECIMALS = 36;
const MAX_SYMBOL = 20;
/** One million micro-USD to the dollar. */
const MICRO_PER_USD = 6;

/**
 * What the chain says a token is, before an operator can price it. The symbol and decimals saved are these, never
 * typed ones: a wrong decimals would misprice every deposit by powers of ten.
 */
export async function readTokenFromChain(client: PublicClient, chainId: number, token: Address): Promise<{ symbol: string; decimals: number }> {
  if ((await client.getChainId()) !== chainId) throw new Error(`the RPC for chain ${chainId} answers as another chain`);
  const code = await client.getCode({ address: token });
  if (!code || code === "0x") throw new Error("There is no contract at that address on this network.");
  const [symbol, decimals] = await Promise.all([client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }), client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" })]);
  const places = Number(decimals);
  if (!Number.isInteger(places) || places < 0 || places > MAX_DECIMALS) throw new Error(`That contract reports ${String(decimals)} decimals.`);
  const name = String(symbol).trim();
  if (!name || name.length > MAX_SYMBOL) throw new Error("That contract does not report a usable symbol.");
  return { symbol: name, decimals: places };
}

/** "0.01" dollars of credit per token as micro-USD. Null for anything that is not a positive amount with at most six decimals. */
export function parseUsdPrice(input: string): bigint | null {
  const match = /^([0-9]{1,9})(?:\.([0-9]{1,6}))?$/.exec(input.trim());
  if (!match) return null;
  const micro = BigInt(match[1]!) * 10n ** BigInt(MICRO_PER_USD) + BigInt((match[2] ?? "").padEnd(MICRO_PER_USD, "0"));
  return micro > 0n ? micro : null;
}

/** A token may be paid with on a testnet only when the operator has said so, as for USDC. */
export function tokenChainAllowed(chainId: number, env: Record<string, string | undefined> = process.env): boolean {
  const chain = appChains.find((candidate) => candidate.id === chainId);
  if (!chain) return false;
  return chain.testnet !== true || env.BILLING_ALLOW_TESTNET_CREDIT === "1";
}

/** The operator's tokens that can be paid with now, and where to send them. Null: there is nowhere to send them. */
export async function tokenRail(db: Db, env: Record<string, string | undefined> = process.env): Promise<{ config: NonNullable<ReturnType<typeof treasuryConfig>>; tokens: PaymentToken[] } | null> {
  const config = treasuryConfig(env);
  if (!config) return null;
  const tokens = (await listPaymentTokens(db, { enabledOnly: true })).filter((token) => tokenChainAllowed(token.chainId, env)).map((token) => ({ ...token, address: getAddress(token.address) }));
  return { config, tokens };
}

/** $10. The app's tokens are free from a faucet, and new addresses are free, so what they buy is capped per account per day. */
const DEFAULT_TOKEN_MAX_PER_DAY_MICROUSD = 10_000_000n;
const DAY_MS = 24 * 60 * 60 * 1000;

/** From `BILLING_TOKEN_MAX_PER_DAY_MICROUSD`, or $10. */
export function tokenDailyCapMicrousd(env: Record<string, string | undefined> = process.env): bigint {
  const raw = env.BILLING_TOKEN_MAX_PER_DAY_MICROUSD;
  return raw && /^[1-9][0-9]{0,15}$/.test(raw) ? BigInt(raw) : DEFAULT_TOKEN_MAX_PER_DAY_MICROUSD;
}

/** The rolling window the daily cap is counted over, for `applyCredit`'s limit. */
export function tokenDailyLimit(now: Date = new Date(), env: Record<string, string | undefined> = process.env): { since: Date; maxMicrousd: bigint } {
  return { since: new Date(now.getTime() - DAY_MS), maxMicrousd: tokenDailyCapMicrousd(env) };
}

/** How much more credit this account may buy with the app's tokens in the last 24 hours. Never below zero. */
export async function tokenCreditLeftToday(db: Db, address: string, now: Date = new Date(), env: Record<string, string | undefined> = process.env): Promise<bigint> {
  const used = await creditedSince(db, { address, kind: "topup_token", since: new Date(now.getTime() - DAY_MS) });
  const left = tokenDailyCapMicrousd(env) - used;
  return left > 0n ? left : 0n;
}

/** Why a token may not be added: a faucet on a real network, or the network's own USDC passed off as something else. Null: it may. */
export function paymentTokenRefusal(input: { chainId: number; address: string; faucet: boolean }, env: Record<string, string | undefined> = process.env): string | null {
  const chain = appChains.find((candidate) => candidate.id === input.chainId);
  if (!chain) return "That network is not served here.";
  if (input.faucet && chain.testnet !== true) return "A token with an open faucet can only buy credit on a test network: anyone could mint credit with it.";
  const usdc = env[`BILLING_USDC_${input.chainId}`];
  if (usdc && usdc.toLowerCase() === input.address.toLowerCase()) return "That is this network's USDC, which already buys credit at $1. It cannot be priced again here.";
  return null;
}
