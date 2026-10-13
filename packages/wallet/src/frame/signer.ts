"use client";

/**
 * Signing, on the wallet origin, one request at a time.
 *
 * This runs ONLY inside the wallet frame (`app/wallet-frame/*`). It is the one
 * place in the app that turns stored bytes into a viem account, and it holds
 * that account for exactly as long as one request takes.
 *
 * ## Decrypt per signature
 *
 * `meraSession.ts` wraps the key under a non-extractable browser key and the
 * connector used to decrypt it once, on resume, and keep the plaintext in a
 * mera signing session for the life of the tab. Here every request restores,
 * signs, and ends: the plaintext exists for the microseconds AES-GCM and
 * secp256k1 take, and a heap snapshot between requests finds a `CryptoKey`
 * handle and ciphertext. AES on 32 bytes is not a cost worth measuring.
 *
 * ## The address is checked every time
 *
 * The stored record names the address it was filed under, and the key is
 * re-derived on every restore. A mismatch ends the session rather than
 * signing: nothing should ever be signed by a key that does not derive the
 * account the caller believes it is talking to.
 *
 * ## The request shapes are the connector's old `makeRequest`
 *
 * Moved here whole — `personal_sign`, `eth_signTypedData_v4`, and
 * `eth_sendTransaction` (with EIP-7702 `authorizationList` forwarded, see the
 * note inline). What changed is where it runs, not what it does. Reads that
 * need no key (`eth_accounts`, `eth_chainId`, everything unknown) never
 * arrive here; the connector answers those on the app side.
 */

import { createSecp256k1SigningSession } from "@category-labs/mera";
import { toViemAccount } from "@category-labs/mera/viem";
import {
  createWalletClient,
  http,
  type Address,
  type Hex,
  type LocalAccount,
} from "viem";
import { walletChains } from "../config";
import {
  endMeraSession,
  meraSessionAddress,
  meraSessionExpiry,
  restoreMeraSession,
  saveMeraSession,
} from "../meraSession";
import { ERR, WalletFrameError, type StatusResult, type WalletRpc } from "./protocol";
import { clearSessionRules } from "./ruleStore";

function chainById(id: number) {
  const chain = walletChains().find((c) => c.id === id);
  if (!chain) throw new WalletFrameError({ code: ERR.INVALID_PARAMS, message: `Chain ${id} is not configured.` });
  return chain;
}

const locked = () =>
  new WalletFrameError({
    code: ERR.LOCKED,
    message: "The passkey session has expired. Connect again to unlock it.",
  });

/** What a stored session says, without decrypting anything. */
export function sessionStatus(): StatusResult {
  return {
    address: (meraSessionAddress() as Address | null) ?? null,
    expiresAt: meraSessionExpiry(),
  };
}

/**
 * Run `fn` with the account for as long as it takes, then zero the key.
 *
 * `restored.privateKey` is the decrypted copy; mera's `session.end()` zeroes
 * its own, and the buffer handed in is zeroed here too so neither survives.
 */
async function withAccount<T>(fn: (account: LocalAccount) => Promise<T>): Promise<T> {
  const restored = await restoreMeraSession();
  if (!restored) throw locked();

  const session = createSecp256k1SigningSession({ privateKey: restored.privateKey });
  try {
    const account = toViemAccount(session);
    if (account.address.toLowerCase() !== restored.address.toLowerCase()) {
      endMeraSession();
      throw locked();
    }
    return await fn(account);
  } finally {
    session.end();
    restored.privateKey.fill(0);
  }
}

/** Confirm a stored session still decrypts, and say whose it is. */
export async function resumeSession(): Promise<Address> {
  return withAccount(async (account) => account.address);
}

/**
 * Take the PRF output from a ceremony the APP ran, and make it this origin's
 * session.
 *
 * The bytes arrive over `postMessage` and are the account: derive the address,
 * persist under the wrapping key, zero the copy. The clock starts now — at the
 * tap — which is what `saveMeraSession` documents.
 */
export async function unlockSession(prfOutput: Uint8Array): Promise<Address> {
  const session = createSecp256k1SigningSession({ privateKey: prfOutput });
  try {
    const address = toViemAccount(session).address;
    await saveMeraSession(prfOutput, address);
    return address;
  } finally {
    session.end();
    prfOutput.fill(0);
  }
}

export function endSession(): void {
  endMeraSession();
  // Session-scoped rules die with the session (spec §5.3). Best effort: a storage
  // failure must not keep the session alive, and an orphaned rule is already
  // unusable once the session it was bounded by has ended.
  void clearSessionRules().catch(() => {});
}

/**
 * Sign — and where the request is a transaction, broadcast — on `chainId`.
 *
 * Returns what an EIP-1193 provider would: a signature hex for the two sign
 * methods, a transaction hash for the two send methods. Signed transaction
 * bytes never leave this function: the frame broadcasts to the chain's RPC
 * itself and hands back the hash, so the app origin never holds anything it
 * could re-broadcast.
 */
export async function executeSigned(chainId: number, rpc: WalletRpc): Promise<Hex> {
  const chain = chainById(chainId);

  return withAccount(async (account) => {
    switch (rpc.method) {
      case "personal_sign": {
        const [data] = rpc.params as [Hex | string, Address];
        return account.signMessage({
          message: typeof data === "string" && data.startsWith("0x") ? { raw: data as Hex } : String(data),
        });
      }

      case "eth_signTypedData_v4":
      case "eth_signTypedData": {
        const [, json] = rpc.params as [Address, string | object];
        return account.signTypedData(typeof json === "string" ? JSON.parse(json) : json);
      }

      case "eth_sendTransaction": {
        const [tx] = rpc.params as [Record<string, Hex> & { authorizationList?: unknown }];
        const wallet = createWalletClient({ account, chain, transport: http() });
        return wallet.sendTransaction({
          to: tx.to as Address,
          data: tx.data,
          value: tx.value ? BigInt(tx.value) : undefined,
          gas: tx.gas ? BigInt(tx.gas) : undefined,
          // EIP-7702. Forwarded rather than dropped, which is what lets this
          // account BATCH. Dropping it silently was an earlier behaviour and
          // the failure worth naming: `signAuthorization` succeeds, the
          // transaction broadcasts, and it simply is not a batch.
          ...(tx.authorizationList ? { authorizationList: tx.authorizationList as never } : {}),
          chain,
        });
      }

      default:
        throw new WalletFrameError({ code: ERR.UNSUPPORTED, message: `The wallet does not sign ${rpc.method}.` });
    }
  });
}
