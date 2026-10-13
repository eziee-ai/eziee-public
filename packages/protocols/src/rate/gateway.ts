import type { z } from "zod";
import { ProtocolError } from "../errors";
import { rateDeployment } from "./chains";

/**
 * Rate's indexer gateway. Everything it returns is UNTRUSTED DATA: it is a
 * third-party server as far as this app is concerned, and its text ends up in
 * front of a language model. So every response is size-capped, schema-checked,
 * and every string is cleaned before it leaves this module's callers.
 */

const MAX_RESPONSE_BYTES = 2_000_000;
const DEFAULT_TIMEOUT_MS = 8_000;

export interface FetchLikeResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  headers?: { get(name: string): string | null };
  body?: ReadableStream<Uint8Array> | null;
}

export type FetchLike = (input: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<FetchLikeResponse>;

const TOO_LARGE = "Rate gateway response was larger than this app accepts";

/**
 * The body as text, refusing anything over the cap measured in BYTES. A declared
 * content-length is refused up front; a streamed body is abandoned the moment it
 * crosses the cap, so an oversized response is never fully buffered.
 */
async function readCapped(response: FetchLikeResponse): Promise<string> {
  const declared = Number(response.headers?.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new ProtocolError("TEMPORARILY_UNAVAILABLE", TOO_LARGE);

  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).length > MAX_RESPONSE_BYTES) throw new ProtocolError("TEMPORARILY_UNAVAILABLE", TOO_LARGE);
    return text;
  }
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new ProtocolError("TEMPORARILY_UNAVAILABLE", TOO_LARGE);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export interface Gateway {
  get<T>(chainId: number, path: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T>;
}

export function createGateway(options: { fetch?: FetchLike; timeoutMs?: number } = {}): Gateway {
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async get(chainId, path, schema) {
      const deployment = rateDeployment(chainId);
      if (!deployment) throw new ProtocolError("UNSUPPORTED_CHAIN", `Rate is not deployed on chain ${chainId}`);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let body: string;
      try {
        const response = await doFetch(`${deployment.gatewayUrl}${path}`, { signal: controller.signal, headers: { accept: "application/json" } });
        if (!response.ok) throw new ProtocolError("TEMPORARILY_UNAVAILABLE", `Rate gateway answered ${response.status} on ${deployment.name}`);
        body = await readCapped(response);
      } catch (error) {
        if (error instanceof ProtocolError) throw error;
        throw new ProtocolError("TEMPORARILY_UNAVAILABLE", `Rate gateway did not answer on ${deployment.name}`, { cause: error });
      } finally {
        clearTimeout(timer);
      }

      let json: unknown;
      try {
        json = JSON.parse(body);
      } catch {
        throw new ProtocolError("TEMPORARILY_UNAVAILABLE", "Rate gateway did not return JSON");
      }
      const parsed = schema.safeParse(json);
      if (!parsed.success) throw new ProtocolError("TEMPORARILY_UNAVAILABLE", `Rate gateway returned an unexpected shape for ${path.split("?")[0]}`);
      return parsed.data;
    },
  };
}
