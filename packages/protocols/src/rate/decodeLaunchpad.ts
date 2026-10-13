import { decodeFunctionData, encodeFunctionData, erc20Abi, getAddress, maxUint256, type Address, type PublicClient } from "viem";
import type { DecodedAction, DecodedApproval, Spend, TxRequest } from "../types";
import { AssetGeneratorABI, LadderBuyerABI } from "./abis";
import { generatorOn, isLadderMarket, ladderBuyerOn, readLaunch } from "./launchpad";
import { rateManifest } from "./manifest";

/**
 * The launchpad's two calls, decoded by first-party code: neither fits a manifest declaration.
 *
 * A LAUNCH carries a name and a ticker the person must see on the card, and a fee that must be exactly the
 * launchpad's own. A LADDER trade names a coin; only the generator's record can say the coin really is a launch
 * coin still selling its ladder in that quote token, so nothing is believed until the chain says so.
 *
 * Both decline (null) anything that is not exactly what this app's builder makes; the wallet then shows raw calldata.
 */

/** The supply every launch mints, as the builder sends it. Any other supply is a launch nobody reviewed here. */
const LAUNCH_SUPPLY = 1_000_000_000n * 10n ** 18n;
const MAX_DEADLINE_S = 3_600n;
const TEXT_MAX = 64;

/** Text from calldata, for the card: printable characters only, capped. */
function shown(text: string, max: number): string {
  // Control characters, zero-width marks and bidirectional overrides: what makes a card read differently from the call.
  const hidden = (code: number) => code < 0x20 || (code >= 0x7f && code <= 0x9f) || (code >= 0x200b && code <= 0x200f) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
  return Array.from(text).filter((ch) => !hidden(ch.codePointAt(0)!)).join("").trim().slice(0, max);
}

function listedToken(chainId: number, token: Address): Address | undefined {
  return rateManifest.tokens[String(chainId)]?.find((t) => t.address.toLowerCase() === token.toLowerCase())?.address;
}

function spendOf(chainId: number, token: Address, amount: bigint): Spend {
  const listed = listedToken(chainId, token);
  return { token: listed ?? getAddress(token), amount, listed: listed !== undefined };
}

export async function decodeRateLaunch(tx: TxRequest, signer: Address, client: PublicClient): Promise<DecodedAction | null> {
  void signer; // A launch pays its creator by being msg.sender: there is no recipient argument to pin.
  try {
    const generator = generatorOn(tx.chainId);
    if (!generator || tx.to.toLowerCase() !== generator.toLowerCase()) return null;
    const { functionName, args } = decodeFunctionData({ abi: AssetGeneratorABI, data: tx.data });
    if (functionName !== "launch") return null;
    if (encodeFunctionData({ abi: AssetGeneratorABI, functionName: "launch", args }).toLowerCase() !== tx.data.toLowerCase()) return null;
    const [name, symbol, supply, quote, devBuy, lockMode] = args;
    if (supply !== LAUNCH_SUPPLY || devBuy <= 0n || (lockMode !== 0 && lockMode !== 1)) return null;
    const cleanName = shown(name, TEXT_MAX);
    const cleanSymbol = shown(symbol, 16);
    // What the card shows must be what is launched: a name or ticker the cleaning changed is not shown at all.
    if (!cleanName || cleanName !== name || !cleanSymbol || cleanSymbol !== symbol) return null;
    const fee = await client.readContract({ address: generator, abi: AssetGeneratorABI, functionName: "launchFee" });
    if (tx.value !== fee) return null;
    const spend: Spend[] = [spendOf(tx.chainId, quote, devBuy), ...(fee > 0n ? [{ token: "native" as const, amount: fee, listed: true }] : [])];
    return {
      protocol: rateManifest.id,
      action: "launch",
      chainId: tx.chainId,
      contract: "assetGenerator",
      spends: true,
      spend,
      unlisted: spend.some((s) => !s.listed),
      // A launch creates a token and buys it: no limit describes that, so it is confirmed every time.
      alwaysAsk: true,
      alwaysAskReason: "This creates a new token and spends your dev buy on it. It always asks.",
      details: [
        { label: "Creates", value: `a new coin, ${cleanName} (${cleanSymbol})` },
        { label: "Supply", value: "1,000,000,000" },
        { label: "Dev buy", value: lockMode === 0 ? "paid to you now; only fees lock" : "vests to you over 12 months" },
      ],
    };
  } catch {
    return null;
  }
}

export async function decodeRateLadderTrade(tx: TxRequest, signer: Address, client: PublicClient): Promise<DecodedAction | null> {
  try {
    const buyer = ladderBuyerOn(tx.chainId);
    if (!buyer || tx.to.toLowerCase() !== buyer.toLowerCase() || tx.value !== 0n) return null;
    const { functionName, args } = decodeFunctionData({ abi: LadderBuyerABI, data: tx.data });
    if (functionName !== "buy" && functionName !== "sell") return null;
    if (encodeFunctionData({ abi: LadderBuyerABI, functionName, args }).toLowerCase() !== tx.data.toLowerCase()) return null;
    const [base, quote, amount, priceBound, minOut, recipient, deadline] = args;
    if (recipient.toLowerCase() !== signer.toLowerCase()) return null;
    if (amount <= 0n || priceBound <= 0n || minOut <= 0n) return null;
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (deadline <= now || deadline > now + MAX_DEADLINE_S) return null;
    // The coin must be one this launchpad launched, still on its ladder, in exactly this quote token.
    const record = await readLaunch(client, tx.chainId, base);
    if (!isLadderMarket(record, quote)) return null;
    const buying = functionName === "buy";
    const [spentToken, gotToken] = buying ? [quote, base] : [base, quote];
    const spend = [spendOf(tx.chainId, spentToken, amount)];
    const got = listedToken(tx.chainId, gotToken);
    return {
      protocol: rateManifest.id,
      action: "swap",
      chainId: tx.chainId,
      contract: "ladderBuyer",
      spends: true,
      spend,
      receive: { token: got ?? getAddress(gotToken), minAmount: minOut, listed: got !== undefined },
      recipient: signer,
      deadline,
      unlisted: spend.some((s) => !s.listed) || got === undefined,
      details: [{ label: "Route", value: buying ? "the coin's launch ladder; whatever cannot fill is returned" : "into resting bids on the coin's market; whatever cannot fill is returned" }],
    };
  } catch {
    return null;
  }
}

/**
 * An exact approval of a LAUNCH COIN to LadderBuyer, which selling one needs. The manifest's approval decoder only
 * names tokens on the reviewed list and a launch coin never is, so this says what it is from the generator's own
 * record: a coin it launched, still on its ladder. It is marked unlisted, so the card names it by address and no
 * rule ever covers it.
 */
export async function decodeRateLadderApproval(tx: TxRequest, client: PublicClient): Promise<DecodedApproval | null> {
  try {
    const buyer = ladderBuyerOn(tx.chainId);
    if (!buyer || tx.value !== 0n) return null;
    const { functionName, args } = decodeFunctionData({ abi: erc20Abi, data: tx.data });
    if (functionName !== "approve") return null;
    if (encodeFunctionData({ abi: erc20Abi, functionName: "approve", args }).toLowerCase() !== tx.data.toLowerCase()) return null;
    const [spender, amount] = args;
    if (spender.toLowerCase() !== buyer.toLowerCase() || amount === 0n) return null;
    const record = await readLaunch(client, tx.chainId, tx.to);
    if (!record || record.graduated) return null;
    return { protocol: rateManifest.id, chainId: tx.chainId, token: getAddress(tx.to), spender: buyer, spenderKey: "ladderBuyer", amount, unlimited: amount === maxUint256, listed: false };
  } catch {
    return null;
  }
}
