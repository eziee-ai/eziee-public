import { describe, expect, it, vi } from "vitest";
import { ProtocolError } from "../errors";
import { createHttpMcpCaller, MAX_MCP_RESPONSE_BYTES } from "./caller";

type Init = { method: string; headers: Record<string, string>; body: string; signal: AbortSignal; redirect: "error" };
const bytes = (text: string) => new TextEncoder().encode(text);

function response(body: string | Uint8Array[], init: { status?: number; type?: string; length?: string } = {}) {
  const chunks = typeof body === "string" ? [bytes(body)] : body;
  return {
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    headers: { get: (name: string) => (name === "content-type" ? (init.type ?? "application/json") : name === "content-length" ? (init.length ?? null) : null) },
    body: new ReadableStream<Uint8Array>({ start: (controller) => (chunks.forEach((chunk) => controller.enqueue(chunk)), controller.close()) }),
    text: async () => (typeof body === "string" ? body : ""),
  };
}
const answer = (id: number, result: unknown) => JSON.stringify({ jsonrpc: "2.0", id, result });
const idOf = (init: Init) => (JSON.parse(init.body) as { id: number }).id;

describe("createHttpMcpCaller", () => {
  it("posts one stateless JSON-RPC call with our key, refuses redirects, and returns the structured content", async () => {
    const fetch = vi.fn(async (_url: string, init: Init) => response(answer(idOf(init), { structuredContent: { ok: 1 }, isError: false })));
    const caller = createHttpMcpCaller({ url: "https://mcp.example/mcp", apiKey: "k-123", fetch });
    expect(await caller.callTool("x.read.y", { a: 1 }, { timeoutMs: 1000 })).toEqual({ isError: false, structuredContent: { ok: 1 } });

    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://mcp.example/mcp");
    expect(init.redirect).toBe("error");
    expect(init.headers).toMatchObject({ authorization: "Bearer k-123", accept: "application/json, text/event-stream", "content-type": "application/json" });
    expect(JSON.parse(init.body)).toMatchObject({ jsonrpc: "2.0", method: "tools/call", params: { name: "x.read.y", arguments: { a: 1 } } });
  });

  it("reads an event-stream answer, skipping messages that are not the reply to this call", async () => {
    const fetch = async (_url: string, init: Init) =>
      response(`event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\nevent: message\ndata: ${answer(idOf(init), { tools: [{ name: "x.read.y", description: "d" }, { nope: true }] })}\n\n`, { type: "text/event-stream" });
    expect(await createHttpMcpCaller({ url: "https://mcp.example/mcp", fetch }).listTools()).toEqual([{ name: "x.read.y", description: "d" }]);
  });

  it("cuts a response off at the cap WHILE it streams, and refuses one that declares itself too large without reading it", async () => {
    const big = Array.from({ length: 10 }, () => bytes("x".repeat(MAX_MCP_RESPONSE_BYTES / 5)));
    await expect(createHttpMcpCaller({ url: "https://mcp.example/mcp", fetch: async () => response(big) }).callTool("t", {}, { timeoutMs: 1000 })).rejects.toMatchObject({ code: "TEMPORARILY_UNAVAILABLE" });
    await expect(createHttpMcpCaller({ url: "https://mcp.example/mcp", fetch: async () => response("{}", { length: String(MAX_MCP_RESPONSE_BYTES + 1) }) }).callTool("t", {}, { timeoutMs: 1000 })).rejects.toMatchObject({ code: "TEMPORARILY_UNAVAILABLE" });
  });

  it("gives up on a server that does not answer in time", async () => {
    const hang = (_url: string, init: Init) => new Promise<never>((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    await expect(createHttpMcpCaller({ url: "https://mcp.example/mcp", fetch: hang }).callTool("t", {}, { timeoutMs: 20 })).rejects.toMatchObject({ code: "TEMPORARILY_UNAVAILABLE", message: expect.stringContaining("too long") });
  });

  it.each([
    ["an HTTP error", async () => response("nope", { status: 502 })],
    ["a JSON-RPC error", async (_u: string, init: Init) => response(JSON.stringify({ jsonrpc: "2.0", id: idOf(init), error: { code: -32000, message: "internal: db password is hunter2" } }))],
    ["an answer to a different call", async () => response(answer(999_999, {}))],
    ["a body that is not JSON", async () => response("<html>")],
    ["a network failure", async () => Promise.reject(new Error("ECONNREFUSED 10.0.0.7 key=k-123"))],
  ])("turns %s into TEMPORARILY_UNAVAILABLE without repeating what the server or the network said", async (_name, fetch) => {
    const failure = await createHttpMcpCaller({ url: "https://mcp.example/mcp", apiKey: "k-123", fetch: fetch as never })
      .callTool("t", {}, { timeoutMs: 1000 })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProtocolError);
    expect((failure as ProtocolError).code).toBe("TEMPORARILY_UNAVAILABLE");
    expect((failure as ProtocolError).message).not.toMatch(/hunter2|k-123|10\.0\.0\.7/);
  });

  it("refuses a server that is not on https, unless a test says it may", () => {
    expect(() => createHttpMcpCaller({ url: "http://mcp.example/mcp" })).toThrow(/https/);
    expect(() => createHttpMcpCaller({ url: "http://localhost:9999/mcp", allowInsecure: true })).not.toThrow();
  });
});
