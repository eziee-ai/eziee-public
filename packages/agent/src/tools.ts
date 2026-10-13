import { jsonSchema, tool, type ToolSet } from "ai";
import type { AdapterContext, ProtocolAdapter } from "@repo/protocols/types";
import { ProtocolError } from "@repo/protocols/errors";
import { z } from "zod";

/**
 * The model's tools, generated from protocol adapters (spec §7.1).
 *
 *   - each `reads.*`   → a SERVER tool: it runs here and the model gets the result
 *   - each `actions.*` → a CLIENT tool: it has no `execute`. The model emits an
 *     intent; the browser builds, simulates, asks the wallet, and reports back.
 *
 * The chain and the wallet address come from the server's session, never from
 * the model: a tool input cannot name whose balances to read.
 */

const READ_ONLY_SUFFIX = " Read-only.";

/** What the browser reports after an action (spec §7.2 step 4). */
export const actionOutputSchema = z.object({
  /** `unfilled`: every transaction confirmed, but nothing was bought or sold (what was spent came back). */
  status: z.enum(["confirmed", "unfilled", "denied", "reverted", "failed"]),
  /** Transaction hashes, in order, for whatever was broadcast. */
  hashes: z.array(z.string()).optional(),
  /** A machine-readable code (a ProtocolError code, or "WALLET") and a plain sentence. */
  code: z.string().optional(),
  message: z.string().optional(),
  /** The network the action ran on, so a saved chat links to the right explorer whatever is selected when it is read. */
  chainId: z.number().int().positive().optional(),
  /** Short labelled facts from the receipt, such as a new coin's address. */
  facts: z.record(z.string().max(64), z.string().max(200)).optional(),
});
export type ActionOutput = z.infer<typeof actionOutputSchema>;

export const toolName = (protocol: string, name: string) => `${protocol}_${name}`;

/** A read failure is RETURNED to the model as data, so it can explain or adjust (spec §10). */
function failure(error: unknown) {
  if (error instanceof ProtocolError) return { error: { code: error.code, message: error.message } };
  if (error instanceof z.ZodError) return { error: { code: "INVALID_INTENT", message: error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") } };
  return { error: { code: "TEMPORARILY_UNAVAILABLE", message: "That could not be read right now." } };
}

export function buildTools(input: { adapters: readonly ProtocolAdapter[]; ctx: AdapterContext }): ToolSet {
  const tools: ToolSet = {};
  const { ctx } = input;

  for (const adapter of input.adapters) {
    if (!adapter.chains.some((chain) => chain.id === ctx.chainId)) continue;

    tools[toolName(adapter.id, "tokens")] = tool({
      description: `The tokens on ${adapter.id}'s reviewed list for this network: symbol, name, address, decimals. Use it to turn a symbol into an address. A token NOT on this list is unreviewed.${READ_ONLY_SUFFIX}`,
      inputSchema: z.object({}),
      execute: async () => ({ tokens: adapter.tokens(ctx.chainId).map(({ address, symbol, name, decimals, trust }) => ({ address, symbol, name, decimals, trust })) }),
    });

    for (const [name, read] of Object.entries(adapter.reads)) {
      tools[toolName(adapter.id, name)] = tool({
        description: `${read.description}${READ_ONLY_SUFFIX}`,
        // A protocol that joined over MCP describes its inputs in JSON Schema; that is what the model should see.
        inputSchema: read.inputJsonSchema ? jsonSchema<Record<string, unknown>>(read.inputJsonSchema) : read.input,
        execute: async (raw: unknown) => {
          try {
            return await read.run(raw, ctx);
          } catch (error) {
            return failure(error);
          }
        },
      });
    }

    for (const [name, action] of Object.entries(adapter.actions)) {
      // No `execute`: this is a client-side tool. The browser answers it with `actionOutputSchema`.
      tools[toolName(adapter.id, name)] = tool({ description: action.description, inputSchema: action.intentJsonSchema ? jsonSchema<Record<string, unknown>>(action.intentJsonSchema) : action.intent, outputSchema: actionOutputSchema });
    }
  }

  // App tools, also answered by the browser.
  tools.getWalletStatus = tool({ description: "Whether a wallet is connected, its address, and the network it is on.", inputSchema: z.object({}), outputSchema: z.object({ connected: z.boolean(), address: z.string().nullable(), chainId: z.number() }) });
  tools.openDeposit = tool({ description: "Open the Deposit screen so the person can fund their wallet. Use when they have no balance or ask how to add funds.", inputSchema: z.object({}), outputSchema: z.object({ opened: z.boolean() }) });
  tools.openWithdraw = tool({ description: "Open the Withdraw screen. Sending funds to an address is always done there by the person; you cannot send funds.", inputSchema: z.object({}), outputSchema: z.object({ opened: z.boolean() }) });

  return tools;
}

/** Which tool names the BROWSER answers, for the client to route on. */
export function clientToolNames(adapters: readonly ProtocolAdapter[]): { actions: Record<string, { protocol: string; action: string }>; app: string[] } {
  const actions: Record<string, { protocol: string; action: string }> = {};
  for (const adapter of adapters) for (const action of Object.keys(adapter.actions)) actions[toolName(adapter.id, action)] = { protocol: adapter.id, action };
  return { actions, app: ["getWalletStatus", "openDeposit", "openWithdraw"] };
}
