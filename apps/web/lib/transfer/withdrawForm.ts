import { encodeFunctionData, erc20Abi, formatUnits, getAddress, isAddress, numberToHex, parseUnits, zeroAddress, type Address } from "viem";
import type { WalletRpc } from "@repo/wallet/frame/protocol";
import type { TokenTrust } from "@repo/protocols/types";
import { paysItsOwnGas } from "./depositMax";
import { isPlausibleAddress, isSelfSend } from "./withdraw";

/** One thing the wallet can send: the chain's native asset or an ERC-20 on it. */
export interface TransferAsset {
  chainId: number;
  token: Address | "native";
  symbol: string;
  name: string;
  /** Read onchain, never assumed. */
  decimals: number;
  /** Base units the wallet holds. */
  held: bigint;
  /** `unreviewed`: a token the person added by address. Shown and sendable, never traded by the assistant. */
  trust: TokenTrust | "unreviewed";
}

/**
 * Whether sending this asset also spends the chain's gas asset, so a fee must be held back.
 * An unreviewed token never does: anyone can deploy a token that calls itself USDC.
 */
export function assetPaysGas(asset: Pick<TransferAsset, "symbol" | "trust">, nativeSymbol: string | undefined): boolean {
  return asset.trust !== "unreviewed" && paysItsOwnGas(asset.symbol, nativeSymbol);
}

export type WithdrawCheck =
  | { ok: true; amount: bigint; recipient: Address }
  | { ok: false; field: "asset" | "amount" | "recipient" | "account"; message: string };

export type AmountCheck = { ok: true; amount: bigint; text: string } | { ok: false; message: string };

/**
 * A typed amount as exact base units, or why not. ASCII digits only: no signs,
 * exponents, separators or look-alike digits. `text` is the canonical form, so
 * what is recorded and shown is what was sent, not what was typed.
 */
export function validateAmount(input: string, asset: Pick<TransferAsset, "symbol" | "decimals">): AmountCheck {
  const text = input.trim();
  if (text === "") return { ok: false, message: "Enter an amount." };
  if (!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(text) && !/^\.[0-9]+$/.test(text)) return { ok: false, message: "Enter the amount as a plain number, like 25 or 0.5." };
  const fraction = text.split(".")[1] ?? "";
  if (fraction.length > asset.decimals) return { ok: false, message: `${asset.symbol} has ${asset.decimals} decimal places. Shorten the amount.` };
  const amount = parseUnits(text.startsWith(".") ? `0${text}` : text, asset.decimals);
  if (amount <= 0n) return { ok: false, message: "Enter an amount greater than zero." };
  return { ok: true, amount, text: formatUnits(amount, asset.decimals) };
}

/**
 * Everything that can be wrong with a withdrawal BEFORE the wallet is asked.
 *
 * A transfer is irreversible, so this is strict where strictness catches a real
 * mistake (a shortened address, a bad checksum, sending to the token contract,
 * more decimals than the token has) and says which field is at fault so the
 * message can sit beside the control.
 */
export function validateWithdraw(input: {
  asset: TransferAsset | null;
  amount: string;
  recipient: string;
  from: string | undefined;
  /** The most that can be sent once the network fee is reserved. Equals `held` unless the asset pays its own gas. */
  max: bigint;
  /**
   * False while the fee cannot be worked out for an asset that pays its own gas. Then `max` is
   * meaningless (a zero reserve would make it the whole balance), so nothing may be sent yet.
   */
  feeKnown?: boolean;
}): WithdrawCheck {
  const { asset, from, max } = input;
  if (!from) return { ok: false, field: "account", message: "Connect your wallet first. There is nothing to send from yet." };
  if (!asset) return { ok: false, field: "asset", message: "Choose what to send." };

  if (input.feeKnown === false) return { ok: false, field: "amount", message: "The network fee could not be read yet, so a safe amount cannot be worked out. Try again in a moment." };
  const parsed = validateAmount(input.amount, asset);
  if (!parsed.ok) return { ok: false, field: "amount", message: parsed.message };
  const amount = parsed.amount;
  if (amount > asset.held) return { ok: false, field: "amount", message: `That is more ${asset.symbol} than this wallet holds.` };
  if (amount > max) return { ok: false, field: "amount", message: `Leave enough ${asset.symbol} for the network fee. Use Max to send the most you can.` };

  const recipient = input.recipient.trim();
  if (recipient === "") return { ok: false, field: "recipient", message: "Enter the address to send to." };
  if (!isPlausibleAddress(recipient)) return { ok: false, field: "recipient", message: "That is not a full address. It must be 0x followed by 40 characters, with nothing shortened." };
  // Mixed case carries an EIP-55 checksum, so a single wrong character is detectable. All-lowercase
  // and all-uppercase carry none: they are accepted and checksummed, not called wrong.
  const hex = recipient.slice(2);
  const hasChecksum = hex !== hex.toLowerCase() && hex !== hex.toUpperCase();
  if (hasChecksum && !isAddress(recipient, { strict: true })) return { ok: false, field: "recipient", message: "That address fails its checksum, so at least one character is wrong. Copy it again from the source." };
  const checksummed = getAddress(`0x${hex.toLowerCase()}`);
  if (checksummed === zeroAddress) return { ok: false, field: "recipient", message: "That is the zero address. Anything sent there is lost." };
  if (isSelfSend(from, checksummed)) return { ok: false, field: "recipient", message: "That is this wallet's own address. Sending to it would only cost a fee." };
  if (asset.token !== "native" && checksummed.toLowerCase() === asset.token.toLowerCase()) return { ok: false, field: "recipient", message: `That is the ${asset.symbol} token contract, not a wallet. Tokens sent there are lost.` };

  return { ok: true, amount, recipient: checksummed };
}

/** The exact request handed to the wallet frame. The frame decodes it again itself and draws the confirm card from that. */
export function buildWithdrawRpc(input: { asset: TransferAsset; amount: bigint; recipient: Address; from: Address | string }): WalletRpc {
  const { asset, amount, recipient, from } = input;
  if (asset.token === "native") return { method: "eth_sendTransaction", params: [{ from, to: recipient, value: numberToHex(amount) }] };
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [recipient, amount] });
  return { method: "eth_sendTransaction", params: [{ from, to: asset.token, data, value: "0x0" }] };
}
