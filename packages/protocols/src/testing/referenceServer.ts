import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * The smallest MCP server that satisfies guideline §5, for tests and as a worked example for a protocol joining:
 * stateless Streamable HTTP, one JSON-RPC request per POST, `tools/list` and `tools/call`, answers in
 * `structuredContent`, errors as `isError` with a code. It checks the bearer key the way a real one must.
 *
 * `tools` maps a tool name to its handler. A handler returns structured content, or throws `{ code, message }`.
 */
export interface ReferenceTool {
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  handle(args: Record<string, unknown>): unknown;
}

export async function startReferenceServer(options: { apiKey: string; tools: Record<string, ReferenceTool>; sse?: boolean }): Promise<{ url: string; close(): Promise<void>; server: Server }> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (request.method !== "POST" || request.headers.authorization !== `Bearer ${options.apiKey}`) {
        response.writeHead(request.method === "POST" ? 401 : 405).end();
        return;
      }
      let rpc: { id?: unknown; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
      try {
        rpc = JSON.parse(Buffer.concat(chunks).toString("utf8")) as typeof rpc;
      } catch {
        response.writeHead(400).end();
        return;
      }
      const reply = (result: unknown) => {
        const body = JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result });
        if (options.sse) response.writeHead(200, { "content-type": "text/event-stream" }).end(`event: message\ndata: ${body}\n\n`);
        else response.writeHead(200, { "content-type": "application/json" }).end(body);
      };

      if (rpc.method === "tools/list") {
        // Guideline §5.1: every tool declares its output, and a read says it is one.
        return reply({ tools: Object.entries(options.tools).map(([name, tool]) => ({ name, description: tool.description, inputSchema: tool.inputSchema ?? { type: "object" }, outputSchema: tool.outputSchema ?? { type: "object" }, ...(name.includes(".read.") ? { annotations: { readOnlyHint: true } } : {}) })) });
      }
      if (rpc.method === "tools/call") {
        const tool = options.tools[rpc.params?.name ?? ""];
        if (!tool) return reply({ isError: true, structuredContent: { code: "INVALID_INTENT", message: "no such tool" } });
        try {
          return reply({ isError: false, structuredContent: tool.handle(rpc.params?.arguments ?? {}) });
        } catch (error) {
          return reply({ isError: true, structuredContent: error });
        }
      }
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "method not found" } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/mcp`, server, close: () => new Promise((resolve) => server.close(() => resolve())) };
}
