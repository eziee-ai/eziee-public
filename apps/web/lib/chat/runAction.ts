import type { Address, Hex, PublicClient } from "viem";
import { z } from "zod";
import { ProtocolError } from "@repo/protocols/errors";
import type { AdapterAction, ReceiptLog, TxRequest } from "@repo/protocols/types";

/**
 * One protocol action, from the model's intent to a settled result (spec §7.2):
 *
 *   parse intent → build → simulate → for each transaction, in order:
 *     (re-simulate it if it was waiting on an approval) → ask the wallet →
 *     wait for the receipt → stop at the first denial, failure or revert.
 *
 * Plain async logic with its effects injected, so every branch is tested
 * without a browser. It never decides whether to sign: `send` hands each
 * transaction to the wallet frame, which decodes it itself and either signs
 * under a rule the user made or asks them.
 */

export type WalletAnswer = { kind: "submitted"; hash: Hex } | { kind: "denied" } | { kind: "failed"; message: string };

export type ActionEvent =
  | { type: "building" }
  | { type: "simulated"; index: number }
  | { type: "asking"; index: number; total: number; tx: TxRequest }
  | { type: "submitted"; index: number; hash: Hex }
  | { type: "mined"; index: number; hash: Hex };

/** What the model is told. Mirrors `actionOutputSchema` in @repo/agent. */
export interface ActionResult {
  /** `unfilled`: confirmed onchain, but nothing was bought or sold; what was spent came back. */
  status: "confirmed" | "unfilled" | "denied" | "reverted" | "failed";
  hashes: Hex[];
  code?: string;
  message?: string;
  /** The network the action ran on. Explorer links use it, whatever network is selected when the chat is read later. */
  chainId?: number;
  /** Short labelled facts read from the receipt, such as a new coin's address. */
  facts?: Record<string, string>;
}

/** A receipt as runAction needs it. A bare status is accepted where the logs are not wanted (no outcome check). */
export type ReceiptAnswer = "success" | "reverted" | { status: "success" | "reverted"; logs: readonly ReceiptLog[] };

export interface RunActionDeps {
  account: Address;
  chainId: number;
  client: PublicClient;
  /** Hands one transaction to the wallet and resolves when it is signed and broadcast, denied, or failed. */
  send: (tx: TxRequest, position: { index: number; total: number }) => Promise<WalletAnswer>;
  waitForReceipt: (hash: Hex) => Promise<ReceiptAnswer>;
  onEvent?: (event: ActionEvent) => void;
  now?: () => number;
}

const failed = (hashes: Hex[], code: string, message: string): ActionResult => ({ status: "failed", hashes, code, message });

// The action's intent type is erased here on purpose: the input comes from a model and is parsed by the action's own schema.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function runAction(action: AdapterAction<any>, input: unknown, deps: RunActionDeps): Promise<ActionResult> {
  const hashes: Hex[] = [];
  const ctx = { chainId: deps.chainId, account: deps.account, client: deps.client };
  deps.onEvent?.({ type: "building" });

  let txs: TxRequest[];
  let deferred: Set<number>;
  let intent: unknown;
  let lastLogs: readonly ReceiptLog[] = [];
  try {
    intent = action.intent.parse(input);
    txs = await action.build(intent, ctx);
    // An adapter answers for ONE chain. A transaction for another would send the wallet somewhere the person never chose.
    if (txs.length === 0) return failed(hashes, "NOTHING_TO_DO", "There was nothing to send for this action.");
    if (txs.some((tx) => tx.chainId !== deps.chainId)) return failed(hashes, "WRONG_CHAIN", "The action was built for a different network than the one selected.");
    const simulation = await action.simulate(txs, ctx);
    if (!simulation.ok) return failed(hashes, "SIMULATION_FAILED", simulation.reason ?? "The transaction would revert.");
    deferred = new Set(simulation.deferred ?? []);
    // Every transaction that could be simulated up front has been; the deferred ones report their own index later.
    for (const index of txs.keys()) if (!deferred.has(index)) deps.onEvent?.({ type: "simulated", index });
  } catch (error) {
    if (error instanceof z.ZodError) return failed(hashes, "INVALID_INTENT", error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
    if (error instanceof ProtocolError) return failed(hashes, error.code, error.message);
    return failed(hashes, "BUILD_FAILED", "The action could not be prepared.");
  }

  for (const [index, tx] of txs.entries()) {
    if (deferred.has(index)) {
      // It could not be simulated before its approval existed. Now it does: check again BEFORE asking the person.
      const again = await action.simulate([tx], ctx).catch(() => ({ ok: false as const, reason: "The transaction could not be simulated." }));
      if (!again.ok) return failed(hashes, "SIMULATION_FAILED", again.reason ?? "The transaction would revert.");
      deps.onEvent?.({ type: "simulated", index });
    }

    // A protocol's quote is priced for a moment. Checked HERE, right before the wallet is asked, because the person
    // may have spent minutes on the step before: signing a swap built for a price that is gone helps nobody.
    const expiry = action.expiresAt?.(txs);
    if (expiry !== undefined && (deps.now ?? Date.now)() >= expiry) return failed(hashes, "QUOTE_EXPIRED", "The quote behind this action expired before it was sent. Nothing further was signed. Ask again for a fresh one.");

    deps.onEvent?.({ type: "asking", index, total: txs.length, tx });
    const answer = await deps.send(tx, { index, total: txs.length });
    if (answer.kind === "denied") return { status: "denied", hashes };
    if (answer.kind === "failed") return failed(hashes, "WALLET", answer.message);

    hashes.push(answer.hash);
    deps.onEvent?.({ type: "submitted", index, hash: answer.hash });
    const receipt = await deps.waitForReceipt(answer.hash).catch(() => "unknown" as const);
    const outcome = typeof receipt === "string" ? receipt : receipt.status;
    lastLogs = typeof receipt === "string" ? [] : receipt.logs;
    if (outcome === "reverted") return { status: "reverted", hashes, message: `Transaction ${index + 1} of ${txs.length} reverted onchain. Nothing after it was sent.` };
    if (outcome === "unknown") return failed(hashes, "UNCONFIRMED", "The network did not confirm the transaction in time. It may still complete; check the explorer before trying again.");
    deps.onEvent?.({ type: "mined", index, hash: answer.hash });
  }
  // Success is not the same as done: a market order that matched nothing succeeds and refunds. Ask the action.
  if (action.outcome) {
    const done = await action.outcome(intent, lastLogs, ctx).catch(() => undefined);
    if (done) return { status: done.filled ? "confirmed" : "unfilled", hashes, message: done.message, ...(done.facts ? { facts: done.facts } : {}) };
  }
  return { status: "confirmed", hashes };
}
