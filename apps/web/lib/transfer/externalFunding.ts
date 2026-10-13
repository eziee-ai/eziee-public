"use client";

import {
  createPublicClient,
  custom,
  encodeFunctionData,
  erc20Abi,
  numberToHex,
  parseUnits,
  type EIP1193Provider,
} from "viem";
import { BRAND } from "@repo/ui/brand";
import { appChains as wagmiChains } from "@/lib/chains";

/**
 * A browser wallet used ONLY to send money to the passkey account.
 *
 * ## Deliberately outside wagmi
 *
 * `lib/providers.tsx` configures exactly one connector — the passkey — so
 * `useAccount()` anywhere in the app is the app's passkey wallet and every write is signed
 * by it. That is the whole point: an injected wallet signs only for the network
 * it is currently on, so as a SIGNER it forces a switch prompt on every
 * cross-chain trade. Removing it from the config removes that class of problem
 * outright.
 *
 * But MetaMask is still where people keep their money, so it keeps a job here —
 * as a funding source. This module talks to it directly over EIP-1193 rather
 * than through wagmi, and that separation is the design rather than an
 * implementation detail:
 *
 *   * nothing here can ever become `useAccount()`. There is no connector, no
 *     entry in the config, no shared store. A bug in this file cannot make the
 *     app sign with the wrong wallet, because the app has no way to reach it.
 *   * the external account is a local value with the lifetime of one deposit.
 *     It is not persisted, not reconnected on load, and not shown as "your"
 *     wallet anywhere.
 *
 * The one thing an injected wallet is good at — one transaction, on one chain,
 * right now — is exactly what a deposit is.
 */

/**
 * Which wallet dialog is open right now.
 *
 * Reported as it happens because a deposit is THREE separate prompts, not one,
 * and a user who approved the first and still sees a spinner concludes the app
 * is broken. Naming the step is what separates "still working" from "stuck".
 */
export type FundingStep = "connect" | "switch" | "add-network" | "send";

export const FUNDING_STEP_LABEL: Record<FundingStep, string> = {
  connect: "Approve the connection",
  switch: "Confirm the network switch",
  "add-network": "Add the network",
  send: "Confirm the transfer",
};

/** One wallet the browser is offering, as EIP-6963 describes it. */
export interface DiscoveredWallet {
  /** Reverse-DNS id, e.g. `io.metamask`. Stable across versions and installs. */
  rdns: string;
  name: string;
  icon: string;
  provider: EIP1193Provider;
}

/**
 * Every injected wallet, not just whoever won the race for `window.ethereum`.
 *
 * With two extensions installed — MetaMask and Rabby, say — they compete to be
 * `window.ethereum` and the winner is whichever injected last. So a user with
 * more than one wallet gets an arbitrary one and no way to choose, which on a
 * deposit screen means signing from the wrong account and wondering why the
 * balance never moved.
 *
 * EIP-6963 exists for exactly this: wallets announce themselves on an event and
 * the page collects them. It is a synchronous burst rather than a request —
 * every installed wallet answers immediately — so a short window is enough, and
 * `window.ethereum` remains the fallback for a wallet too old to announce.
 */
export function discoverWallets(timeoutMs = 300): Promise<DiscoveredWallet[]> {
  if (typeof window === "undefined") return Promise.resolve([]);

  return new Promise((resolve) => {
    const found = new Map<string, DiscoveredWallet>();

    const onAnnounce = (event: Event) => {
      const detail = (event as CustomEvent).detail as
        | { info?: { rdns?: string; name?: string; icon?: string }; provider?: EIP1193Provider }
        | undefined;
      const rdns = detail?.info?.rdns;
      if (!rdns || !detail?.provider) return;
      // Keyed on rdns so a wallet announcing twice is one entry.
      found.set(rdns, {
        rdns,
        name: detail.info?.name ?? rdns,
        icon: detail.info?.icon ?? "",
        provider: detail.provider,
      });
    };

    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));

    window.setTimeout(() => {
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
      const legacy = (window as { ethereum?: EIP1193Provider }).ethereum;
      // Only when nothing announced: a wallet that supports 6963 is already in
      // the map, and adding `window.ethereum` too would list it twice under a
      // name we cannot read.
      if (found.size === 0 && legacy) {
        found.set("legacy", { rdns: "legacy", name: "Browser wallet", icon: "", provider: legacy });
      }
      resolve([...found.values()]);
    }, timeoutMs);
  });
}

/*
 * There is deliberately NO "probe every discovered wallet" helper here.
 *
 * `probeWallets` was one, and it was called when the deposit panel opened —
 * `eth_chainId` at every announced provider to drop the ones that cannot carry
 * an EVM transfer, then `eth_accounts` at each survivor so an already-connected
 * wallet could lead the list. Its own comment called `eth_chainId` "a silent
 * read that any EVM provider answers", which is true of MetaMask and Rabby and
 * is not a property of the interface. A wallet that treats the first request
 * from an unknown origin as a request to CONNECT opens its approval popup, so
 * visiting `/deposit` raised a dialog from every such extension installed —
 * before the user had picked anything, and from wallets they may never use.
 *
 * Nothing could have caught it here: every test drives a mock that answers what
 * it is told, so a wallet that prompts and one that does not are the same
 * object. The rule that replaced it is testable by counting instead — the first
 * request to any wallet is the one the user's Connect click makes, and
 * `DepositPanel.test.tsx` pins that no provider is spoken to before it.
 *
 * If a list ever needs filtering or ordering again, it has to be bought with a
 * gesture, not with a page load.
 */

/** The window's injected provider, or null when there is no browser wallet. */
export function injectedProvider(): EIP1193Provider | null {
  if (typeof window === "undefined") return null;
  const provider = (window as { ethereum?: EIP1193Provider }).ethereum;
  return provider ?? null;
}

export function hasInjectedProvider(): boolean {
  return injectedProvider() !== null;
}

/** Thrown when the user dismisses a wallet prompt. Not an error worth a toast. */
export function isUserRejection(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  // 4001 is EIP-1193's userRejectedRequest. The message test catches wallets
  // that report the rejection without the code.
  if (code === 4001) return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /user rejected|user denied|rejected the request/i.test(message);
}

/**
 * Put the external wallet on `chainId`, adding the chain if it has never seen it.
 *
 * A deposit is the one moment a switch prompt is WORTH paying: it happens once
 * per chain, at a point the user has already decided to move money, rather than
 * interrupting a trade. `wallet_switchEthereumChain` answers 4902 for an unknown
 * chain, which is a request to add it rather than a failure — a testnet nobody
 * has configured is the normal case here, not an edge one.
 */
async function ensureChain(
  provider: EIP1193Provider,
  chainId: number,
  onStep?: (step: FundingStep) => void,
): Promise<void> {
  const hex = `0x${chainId.toString(16)}`;

  /*
   * ASK THE WALLET WHERE IT IS FIRST.
   *
   * `wallet_switchEthereumChain` is a prompt, and firing it blind prompts a user
   * who is already on the right chain — the common case for anyone depositing a
   * second time. `eth_chainId` is a silent read, so the switch is only requested
   * when it would actually change something.
   *
   * This matters more here than it looks, because the deposit is the ONLY place
   * in the app that can ask a wallet to switch at all: the passkey signs every
   * trade and names its chain per transaction, so it has no ambient network to
   * move. Every switch prompt a user ever sees comes from this function, which
   * makes not firing a needless one worth a round trip.
   */
  try {
    const current = (await provider.request({ method: "eth_chainId" })) as string;
    if (typeof current === "string" && current.toLowerCase() === hex.toLowerCase()) return;
  } catch {
    // A wallet that will not answer where it is still gets asked to switch —
    // the request below reports its own failure clearly enough.
  }

  try {
    onStep?.("switch");
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: hex }],
    } as never);
    return;
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (code !== 4902 && !/unrecognized chain|unsupported chain/i.test(String((error as Error)?.message))) {
      throw error;
    }
  }

  const chain = wagmiChains.find((c) => c.id === chainId);
  if (!chain) throw new Error(`${BRAND} does not serve chain ${chainId}.`);

  onStep?.("add-network");
  await provider.request({
    method: "wallet_addEthereumChain",
    params: [
      {
        chainId: hex,
        chainName: chain.name,
        nativeCurrency: chain.nativeCurrency,
        rpcUrls: [...chain.rpcUrls.default.http],
        blockExplorerUrls: chain.blockExplorers?.default?.url
          ? [chain.blockExplorers.default.url]
          : undefined,
      },
    ],
  } as never);
}

/** The account the external wallet is offering, after prompting for access. */
export async function connectExternalWallet(): Promise<`0x${string}`> {
  return connectWallet();
}

/**
 * Prompt a specific wallet to connect, and answer with the account it gives.
 *
 * Separate from `fundPasskeyWallet` because connecting and sending are two
 * decisions and the UI now asks them in order. Folded together, the first click
 * on "Deposit" was a CONNECT — and when the wallet had already authorised the
 * site it resolved with no dialog at all, so the button appeared to do nothing
 * while quietly moving to the next step.
 */
export async function connectWallet(wallet?: DiscoveredWallet): Promise<`0x${string}`> {
  const provider = wallet?.provider ?? injectedProvider();
  if (!provider) throw new Error("No browser wallet found in this browser.");
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as `0x${string}`[];
  const account = accounts?.[0];
  if (!account) throw new Error("The wallet returned no account.");
  return account;
}

/**
 * The account a wallet has ALREADY authorised, or null.
 *
 * `eth_accounts` never prompts — it reports what is already granted. That is
 * what lets the button say "Connect MetaMask" or "Deposit 0.05 USDC" correctly
 * on first paint, rather than discovering which it meant only after a click.
 */
export async function authorisedAccount(
  wallet?: DiscoveredWallet,
): Promise<`0x${string}` | null> {
  const provider = wallet?.provider ?? injectedProvider();
  if (!provider) return null;
  try {
    const accounts = (await provider.request({ method: "eth_accounts" })) as `0x${string}`[];
    return accounts?.[0] ?? null;
  } catch {
    // A wallet that refuses to answer is treated as not connected: the connect
    // step is idempotent, so the cost of asking again is one dialog.
    return null;
  }
}

/** What a deposit needs to know before it can ask for a signature. */
export interface FundingPreflight {
  account: `0x${string}`;
  /** The wallet is already standing on the target chain. */
  onChain: boolean;
  /** Balance of the asset being sent, in its own smallest unit. */
  held: bigint;
  /**
   * Wei per gas, in the chain's NATIVE view. Null when the read failed.
   *
   * Here so "Max" can hold gas back on a chain where the asset being deposited
   * is also what pays for the deposit — Arc, where the gas asset IS USDC. Null
   * is a real answer and must not be read as free: `gasReserve` reserves
   * nothing rather than inventing a price it could not read.
   */
  gasPrice: bigint | null;
}

/**
 * Everything that has to be READ before a deposit, done ahead of the click.
 *
 * ## Why this is separate, and why it matters more than it looks
 *
 * `fundPasskeyWallet` used to do all of this inline: check the authorisation,
 * read the chain, read the balance, then ask for a signature. Three RPC round
 * trips, all awaited, and only then the request that opens the wallet.
 *
 * That is enough to lose the user gesture. A browser wallet opens its popup on
 * the strength of the click that led to it; several awaits later the request
 * arrives without one, and MetaMask does not surface a window — it queues the
 * transaction behind a badge on its toolbar icon, with nothing on the page to
 * say so. The reported symptom is exact: the app shows a spinner and MetaMask
 * never changes.
 *
 * So the reads happen while the user is still typing an amount, and the click
 * issues the signature request first, with no await in front of it.
 */
export async function preflightFunding({
  chainId,
  amount,
  wallet: chosen,
  token,
}: {
  chainId: number;
  amount: string;
  wallet?: DiscoveredWallet;
  token?: { address: `0x${string}`; decimals: number; symbol: string };
}): Promise<FundingPreflight | null> {
  const provider = chosen?.provider ?? injectedProvider();
  const chain = wagmiChains.find((c) => c.id === chainId);
  if (!provider || !chain) return null;

  const account = await authorisedAccount(chosen);
  // Not connected yet: the UI asks for that separately, and probing further
  // would prompt.
  if (!account) return null;

  let onChain = false;
  try {
    const current = (await provider.request({ method: "eth_chainId" })) as string;
    const hex = `0x${chainId.toString(16)}`;
    onChain = typeof current === "string" && current.toLowerCase() === hex.toLowerCase();
  } catch {
    onChain = false;
  }

  // Read through the WALLET's own provider, so the number is the one it will
  // use a moment later. A public client on a different node can lag and reject
  // a deposit that would have succeeded.
  const reader = createPublicClient({ chain, transport: custom(provider) });
  let held = BigInt(0);
  try {
    held = token
      ? await reader.readContract({
          abi: erc20Abi,
          address: token.address,
          functionName: "balanceOf",
          args: [account],
        })
      : await reader.getBalance({ address: account });
  } catch {
    // An unreadable balance must not block a deposit the wallet would accept.
    // The wallet reports a shortfall itself; this check only exists to say so
    // in better words, before a signature is spent on it.
    held = parseUnits(amount || "0", token ? token.decimals : chain.nativeCurrency.decimals);
  }

  /*
   * Read alongside the balance, not at click time. Both feed the Max button,
   * which the user presses before the send — and the click path must stay free
   * of awaits for the reason this function's own docstring gives.
   *
   * A failure is null, never a guess: see `FundingPreflight.gasPrice`.
   */
  let gasPrice: bigint | null = null;
  try {
    gasPrice = await reader.getGasPrice();
  } catch {
    gasPrice = null;
  }

  return { account, onChain, held, gasPrice };
}

/**
 * Ask for the signature. Nothing is read here.
 *
 * The only await before the wallet request is `ensureChain`, and only when the
 * wallet is on the wrong network — where a prompt is expected anyway, so the
 * gesture is already spent on a dialog the user can see.
 */
export async function sendFunding({
  to,
  chainId,
  amount,
  account,
  wallet: chosen,
  token,
  needsSwitch,
  onStep,
}: {
  to: `0x${string}`;
  chainId: number;
  amount: string;
  account: `0x${string}`;
  wallet?: DiscoveredWallet;
  token?: { address: `0x${string}`; decimals: number; symbol: string };
  /** From the preflight. When true a switch is requested before sending. */
  needsSwitch: boolean;
  onStep?: (step: FundingStep) => void;
}): Promise<`0x${string}`> {
  const provider = chosen?.provider ?? injectedProvider();
  if (!provider) throw new Error("No browser wallet found in this browser.");
  const chain = wagmiChains.find((c) => c.id === chainId);
  if (!chain) throw new Error(`${BRAND} does not serve chain ${chainId}.`);

  if (needsSwitch) await ensureChain(provider, chainId, onStep);

  const decimals = token ? token.decimals : chain.nativeCurrency.decimals;
  const value = parseUnits(amount, decimals);

  /*
   * `eth_sendTransaction` on the provider directly, not through a viem wallet
   * client.
   *
   * The client is the nicer API and it costs a round trip: `sendTransaction`
   * verifies the chain with its own `eth_chainId` before forwarding, which puts
   * a read back in front of the wallet request — the exact thing this split
   * removed. The preflight already established the chain, and `needsSwitch`
   * above already moved it, so the check is re-asking a question we answered.
   *
   * `encodeFunctionData` and `numberToHex` are pure, so from the click there is
   * one request and nothing before it.
   */
  onStep?.("send");
  const params = token
    ? {
        from: account,
        // An ERC-20 transfer is a call to the CONTRACT carrying the recipient
        // in its arguments. Sending `value` to a token address instead would
        // hand it the chain's own asset, which most tokens reject and some
        // keep.
        to: token.address,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "transfer",
          args: [to, value],
        }),
      }
    : { from: account, to, value: numberToHex(value) };

  return (await provider.request({
    method: "eth_sendTransaction",
    params: [params],
  } as never)) as `0x${string}`;
}
