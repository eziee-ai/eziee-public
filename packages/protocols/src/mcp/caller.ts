import { ProtocolError } from "../errors";

/** One tool as `tools/list` reports it. Every field is the server's own claim. */
export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
}

export interface McpToolResult {
  isError?: boolean;
  structuredContent?: unknown;
}

/**
 * The two MCP requests an adapter needs, and nothing else. On our server this is
 * `createHttpMcpCaller`; in the browser it is a fetch to our own proxy route,
 * because the API key a protocol issues us never leaves the server.
 */
export interface McpCaller {
  listTools(): Promise<McpToolInfo[]>;
  callTool(name: string, args: Record<string, unknown>, options: { timeoutMs: number }): Promise<McpToolResult>;
}

/** Guideline §5.4. A response is cut off at this many bytes, while it streams, not after. */
export const MAX_MCP_RESPONSE_BYTES = 64 * 1024;
const LIST_TIMEOUT_MS = 3000;
const PROTOCOL_VERSION = "2025-06-18";

type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal; redirect: "error" }) => Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null }; body: ReadableStream<Uint8Array> | null; text(): Promise<string> }>;

const unavailable = (why: string, cause?: unknown) => new ProtocolError("TEMPORARILY_UNAVAILABLE", why, cause === undefined ? undefined : { cause });

async function readCapped(response: Awaited<ReturnType<FetchLike>>): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_MCP_RESPONSE_BYTES) throw unavailable("The protocol's server sent more than it may");
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).length > MAX_MCP_RESPONSE_BYTES) throw unavailable("The protocol's server sent more than it may");
    return text;
  }
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_MCP_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw unavailable("The protocol's server sent more than it may");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/** A Streamable HTTP answer is either one JSON body or an SSE stream whose `data:` lines carry JSON-RPC messages. */
function messageFor(id: number, contentType: string, body: string): { result?: unknown; error?: unknown } {
  const candidates = contentType.includes("text/event-stream")
    ? body
        .split(/\r?\n\r?\n/)
        .map((event) => event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n"))
        .filter((data) => data !== "")
    : [body];
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (typeof parsed === "object" && parsed !== null && (parsed as { id?: unknown }).id === id) return parsed as { result?: unknown; error?: unknown };
  }
  throw unavailable("The protocol's server did not answer the request");
}

/**
 * MCP over Streamable HTTP, as little of it as the guideline (§5) asks of a server: stateless,
 * so every request stands alone with no `initialize` and no session id. HTTPS only, redirects
 * refused (a redirect would carry our key to wherever the server points), byte-capped, timed out.
 */
export function createHttpMcpCaller(options: { url: string; apiKey?: string; fetch?: FetchLike; allowInsecure?: boolean }): McpCaller {
  const url = new URL(options.url);
  if (url.protocol !== "https:" && !(options.allowInsecure && url.protocol === "http:")) throw new ProtocolError("INVALID_MANIFEST", "An MCP server must be reached over https");
  const doFetch = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  let nextId = 1;

  async function rpc(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const id = nextId++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(url.href, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": PROTOCOL_VERSION, ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}) },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw unavailable(`The protocol's server answered ${response.status}`);
      }
      const message = messageFor(id, response.headers.get("content-type") ?? "", await readCapped(response));
      if (message.error !== undefined || message.result === undefined) throw unavailable("The protocol's server refused the request");
      return message.result;
    } catch (error) {
      if (error instanceof ProtocolError) throw error;
      // The cause may name hosts or carry header text. It is kept for logs and never shown.
      throw unavailable(controller.signal.aborted ? "The protocol's server took too long" : "The protocol's server could not be reached", error);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async listTools() {
      const result = (await rpc("tools/list", {}, LIST_TIMEOUT_MS)) as { tools?: unknown };
      if (!Array.isArray(result.tools)) throw unavailable("The protocol's server listed no tools");
      return result.tools.filter((tool): tool is McpToolInfo => typeof tool === "object" && tool !== null && typeof (tool as { name?: unknown }).name === "string");
    },
    async callTool(name, args, { timeoutMs }) {
      const result = (await rpc("tools/call", { name, arguments: args }, timeoutMs)) as McpToolResult;
      return { isError: result.isError === true, structuredContent: result.structuredContent };
    },
  };
}
