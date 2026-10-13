import { NextResponse } from "next/server";
import type { Address, Chain, PublicClient } from "viem";
import { z } from "zod";
import { ProtocolError } from "@repo/protocols/errors";
import type { Manifest } from "@repo/protocols/manifest";
import { createHttpMcpCaller, createMcpAdapter, type McpCaller } from "@repo/protocols/mcp";
import type { ProtocolAdapter } from "@repo/protocols/types";
import { problem } from "./http";

/**
 * Every protocol the SERVER can use: the first-party adapters, plus each Verified protocol (guideline §3) whose
 * manifest is bundled in this build AND whose server is configured for this deployment and answering.
 *
 * Which protocols are TRUSTED is decided at build time, by the manifest list. Configuration only says where a
 * trusted protocol's server is; it cannot add a protocol.
 */

/** A server's tool list is asked for this often, not on every message. */
const REFRESH_MS = 5 * 60_000;
/** After a failure, ask again this soon: a brief outage must not hide a protocol for the whole refresh period. */
const RETRY_MS = 15_000;
/** The longest a transaction set handed to the browser is good for. A protocol's own, sooner expiry wins. The browser's action runner checks it right before each transaction is sent. */
const BUILD_TTL_SECONDS = 60;

/** `MCP_<ID>_URL` and `MCP_<ID>_KEY`, with the id upper-cased and dashes as underscores. No URL: not offered. */
export function mcpEndpoint(id: string): { url: string; apiKey: string | undefined } | null {
  const prefix = `MCP_${id.toUpperCase().replace(/-/g, "_")}`;
  const url = process.env[`${prefix}_URL`];
  return url ? { url, apiKey: process.env[`${prefix}_KEY`] || undefined } : null;
}

export interface ProtocolSource {
  adapters(): Promise<ProtocolAdapter[]>;
}

export function createProtocolSource(options: {
  firstParty: readonly ProtocolAdapter[];
  verified: readonly Manifest[];
  chains: readonly Chain[];
  /** Tests inject a caller; production builds one from the environment. Null: this protocol has no server here. */
  callerFor?: (manifest: Manifest) => McpCaller | null;
  now?: () => number;
}): ProtocolSource {
  const now = options.now ?? Date.now;
  const callerFor =
    options.callerFor ??
    ((manifest: Manifest) => {
      const endpoint = mcpEndpoint(manifest.id);
      return endpoint ? createHttpMcpCaller(endpoint) : null;
    });
  const cache = new Map<string, { at: number; adapter: ProtocolAdapter | null }>();
  const inFlight = new Map<string, Promise<ProtocolAdapter | null>>();

  function load(manifest: Manifest): Promise<ProtocolAdapter | null> {
    const cached = cache.get(manifest.id);
    if (cached && now() - cached.at < (cached.adapter ? REFRESH_MS : RETRY_MS)) return Promise.resolve(cached.adapter);
    // Several requests on a cold start share one listing, not one each.
    let pending = inFlight.get(manifest.id);
    if (!pending) {
      const caller = callerFor(manifest);
      // One protocol's server being down must not take the chat, or the other protocols, down with it.
      pending = (caller ? createMcpAdapter({ manifest, chains: options.chains, caller, now }).catch(() => null) : Promise.resolve(null)).then((adapter) => {
        cache.set(manifest.id, { at: now(), adapter });
        inFlight.delete(manifest.id);
        return adapter;
      });
      inFlight.set(manifest.id, pending);
    }
    return pending;
  }

  return {
    async adapters() {
      const verified = await Promise.all(options.verified.map(load));
      return [...options.firstParty, ...verified.filter((adapter): adapter is ProtocolAdapter => adapter !== null)];
    },
  };
}

const buildBody = z.object({ action: z.string().min(1).max(40), chainId: z.number().int().positive(), intent: z.record(z.unknown()) });

/**
 * The browser asks OUR server to ask a protocol's server for transactions (the protocol's key never leaves here).
 * The account is the signed-in session's, never the body's: a page cannot have transactions built that pay
 * someone else. What the protocol's server sends is checked against the manifest inside the adapter, and again
 * by the browser, and again by the wallet.
 */
export async function handleBuild(input: { source: ProtocolSource; protocolId: string; address: Address; body: unknown; clientFor: (chainId: number) => PublicClient | null | Promise<PublicClient | null>; now?: () => number }): Promise<NextResponse> {
  const parsed = buildBody.safeParse(input.body);
  if (!parsed.success) return problem(400, "INVALID_REQUEST", "The build request was not valid.");
  const adapter = (await input.source.adapters()).find((candidate) => candidate.id === input.protocolId);
  if (!adapter) return problem(404, "UNKNOWN_PROTOCOL", "That protocol is not available here.");
  const action = Object.hasOwn(adapter.actions, parsed.data.action) ? adapter.actions[parsed.data.action] : undefined;
  if (!action) return problem(404, "UNKNOWN_ACTION", "That protocol has no such action.");
  const client = await input.clientFor(parsed.data.chainId);
  if (!client || !adapter.chains.some((chain) => chain.id === parsed.data.chainId)) return problem(400, "UNSUPPORTED_CHAIN", "That network is not served here.");

  try {
    const intent: unknown = action.intent.parse(parsed.data.intent);
    const txs = await action.build(intent, { chainId: parsed.data.chainId, account: input.address, client });
    const ours = Math.floor((input.now ?? Date.now)() / 1000) + BUILD_TTL_SECONDS;
    const theirs = action.expiresAt?.(txs);
    const expiresAt = theirs === undefined ? ours : Math.min(ours, Math.floor(theirs / 1000));
    return NextResponse.json({ txs: txs.map((tx) => ({ chainId: tx.chainId, to: tx.to, data: tx.data, value: tx.value.toString() })), expiresAt }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof ProtocolError) return problem(422, error.code, error.message);
    if (error instanceof z.ZodError) return problem(422, "INVALID_INTENT", "The intent was not valid for this action.");
    console.error("[protocols] a build failed unexpectedly", error);
    return problem(422, "TEMPORARILY_UNAVAILABLE", "That protocol cannot be reached right now.");
  }
}
