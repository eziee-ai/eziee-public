import type { Chain } from "viem";
import { z } from "zod";
import { ProtocolError, type ProtocolErrorCode } from "../errors";
import { decodeAction, manifestContracts, manifestTokens, type Manifest } from "../manifest";
import { simulate } from "../simulate";
import { clean } from "../text";
import type { AdapterAction, ProtocolAdapter } from "../types";
import { acceptBuild, expiryOf } from "./adapter";

/**
 * An MCP protocol as the BROWSER sees it.
 *
 * The browser runs actions (it builds, simulates and hands transactions to the wallet frame), but it cannot call
 * a protocol's server: the key that server issued us must never reach a browser. So `build` asks OUR server,
 * which asks theirs. The account is not sent: our server uses the signed-in session's address, so a page cannot
 * ask for transactions that pay someone else.
 *
 * What comes back is checked again here, against the manifest bundled into this page, by the same rule the
 * server applied. Our own server is thereby held to the manifest too.
 *
 * Reads are not offered: a model's reads run on the server, where the real adapter is.
 */

// UNKNOWN_ACTION and UNKNOWN_PROTOCOL are our own server saying this build does not offer it: the intent cannot be served.
const OURS: Record<string, ProtocolErrorCode> = { UNKNOWN_ACTION: "INVALID_INTENT", UNKNOWN_PROTOCOL: "TEMPORARILY_UNAVAILABLE" };
const CODES = new Set<ProtocolErrorCode>(["INVALID_INTENT", "UNKNOWN_TOKEN", "UNSUPPORTED_CHAIN", "QUOTE_MOVED", "INSUFFICIENT_LIQUIDITY", "AMOUNT_TOO_SMALL", "TEMPORARILY_UNAVAILABLE"]);
type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export function createProxiedMcpAdapter(options: { manifest: Manifest; chains: readonly Chain[]; fetch?: FetchLike; now?: () => number }): ProtocolAdapter {
  const { manifest } = options;
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const now = options.now ?? Date.now;
  const unavailable = () => new ProtocolError("TEMPORARILY_UNAVAILABLE", `${manifest.name} cannot be reached right now`);

  const actions: Record<string, AdapterAction<Record<string, unknown>>> = {};
  for (const [name, action] of Object.entries(manifest.actions)) {
    actions[name] = {
      description: `${action.title} on ${manifest.name}.`,
      intent: z.record(z.unknown()),
      async build(intent, ctx) {
        let response: Awaited<ReturnType<FetchLike>>;
        let body: unknown;
        try {
          response = await doFetch(`/api/protocols/${manifest.id}/build`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: name, chainId: ctx.chainId, intent }) });
          body = await response.json();
        } catch {
          throw unavailable();
        }
        if (!response.ok) {
          const { code, message } = ((body as { error?: unknown } | null)?.error ?? {}) as { code?: unknown; message?: unknown };
          const known = typeof code === "string" ? (OURS[code] ?? (CODES.has(code as ProtocolErrorCode) ? (code as ProtocolErrorCode) : undefined)) : undefined;
          if (!known) throw unavailable();
          throw new ProtocolError(known, clean(message, 200) || `${manifest.name} could not prepare this`);
        }
        return acceptBuild(manifest, name, body, { chainId: ctx.chainId, account: ctx.account, nowMs: now() });
      },
      simulate,
      expiresAt: expiryOf,
    };
  }

  return {
    id: manifest.id,
    chains: options.chains.filter((chain) => manifest.chains.includes(chain.id)),
    contracts: (chainId) => manifestContracts(manifest, chainId),
    tokens: (chainId) => manifestTokens(manifest, chainId),
    actions,
    reads: {},
    decode: (_chainId, tx, signer) => decodeAction(manifest, tx, signer),
  };
}
