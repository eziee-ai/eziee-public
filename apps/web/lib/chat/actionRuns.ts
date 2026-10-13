"use client";

import { useSyncExternalStore } from "react";
import { numberToHex, type Address, type Hex, type PublicClient } from "viem";
import type { AdapterAction, TxRequest } from "@repo/protocols/types";
import { walletFrame } from "@repo/wallet/frame/client";
import { ERR, toFrameError, type WalletRpc } from "@repo/wallet/frame/protocol";
import { describeWalletFailure } from "@repo/wallet/walletFailure";
import { runAction, type ActionResult, type WalletAnswer } from "./runAction";

/**
 * Live action runs, keyed by tool call id, outside React.
 *
 * A run starts from the chat's `onToolCall` callback, which fires ONLY for a
 * tool call that has just streamed in. That is the safeguard: an action found in
 * a reloaded transcript is history, and nothing here will ever run it again.
 *
 * Three more rules, each closing a way this could go wrong:
 *
 * ONE AT A TIME. Two actions in one reply would otherwise show two wallet
 * prompts at once and send two transactions from the same nonce. Runs queue.
 *
 * A RUN BELONGS TO THE VIEW THAT STARTED IT. Reporting a result feeds it to the
 * model, which is a new, billed request. If the person has left that chat, the
 * request would be for a reply they never see. So once a view detaches, its
 * runs finish quietly: the result is kept for the card, and nothing is reported.
 *
 * AN ASK NEVER OUTLIVES ITS PROMPT. When the view goes while the wallet is
 * asking, the prompt goes with it, and nothing could ever answer. The ask is
 * dismissed, which ends the run as a denial: nothing signed, nothing hanging.
 */

export interface ActionRunState {
  phase: "queued" | "preparing" | "asking" | "confirming" | "done";
  /** The network the run was started on. Explorer links use this, not whatever network is selected later. */
  chainId: number;
  index: number;
  total: number;
  /** Set while the wallet must ask the person: the request its confirm frame is shown. */
  ask: { chainId: number; rpc: WalletRpc } | null;
  hashes: Hex[];
  result: ActionResult | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the intent type is the action's own; the input is parsed by its schema
export interface StartActionRun { toolCallId: string; owner: object; action: AdapterAction<any>; intent: unknown; account: Address; chainId: number; client: PublicClient; gasSymbol: string; report: (result: ActionResult) => void }

/** Finished runs kept so a card can still show its result. The oldest are forgotten past this many. */
export const MAX_KEPT_RUNS = 50;

const toRpc = (tx: TxRequest, from: Address): WalletRpc => ({ method: "eth_sendTransaction", params: [{ from, to: tx.to, data: tx.data, value: numberToHex(tx.value) }] });

export function createActionRuns(wallet: { request: (chainId: number, rpc: WalletRpc) => Promise<Hex> }) {
  const runs = new Map<string, ActionRunState>();
  const owners = new Map<string, object>();
  const resolvers = new Map<string, (answer: WalletAnswer) => void>();
  const detached = new WeakSet<object>();
  const listeners = new Set<() => void>();
  let queue: Promise<void> = Promise.resolve();

  const set = (id: string, patch: Partial<ActionRunState>) => {
    const current = runs.get(id);
    if (!current) return;
    runs.set(id, { ...current, ...patch });
    for (const listener of listeners) listener();
  };

  const forgetOldest = () => {
    for (const [id, run] of runs) {
      if (runs.size <= MAX_KEPT_RUNS) return;
      if (run.phase !== "done") continue;
      runs.delete(id);
      owners.delete(id);
    }
  };

  const answer = (toolCallId: string, given: WalletAnswer): void => {
    const resolve = resolvers.get(toolCallId);
    if (!resolve) return;
    resolvers.delete(toolCallId);
    set(toolCallId, { ask: null, phase: given.kind === "submitted" ? "confirming" : "preparing" });
    resolve(given);
  };

  async function execute(input: StartActionRun): Promise<ActionResult> {
    if (detached.has(input.owner)) return { status: "failed", hashes: [], code: "CANCELLED", message: "The chat was closed before this action started. Nothing was sent." };
    set(input.toolCallId, { phase: "preparing" });

    const send = async (tx: TxRequest, position: { index: number; total: number }): Promise<WalletAnswer> => {
      const rpc = toRpc(tx, input.account);
      set(input.toolCallId, { index: position.index, total: position.total, phase: "preparing" });
      try {
        // Silent first: the frame signs only if a rule the person made covers exactly this transaction.
        return { kind: "submitted", hash: await wallet.request(tx.chainId, rpc) };
      } catch (error) {
        const frameError = toFrameError(error);
        if (frameError.code === ERR.USER_REJECTED) return { kind: "denied" };
        if (frameError.code !== ERR.CONFIRM_REQUIRED) return { kind: "failed", message: describeWalletFailure(error, { gasSymbol: input.gasSymbol }) ?? frameError.message };
      }
      // The wallet wants to ask. With nobody left to show the prompt to, that is a no.
      if (detached.has(input.owner)) return { kind: "denied" };
      return new Promise<WalletAnswer>((resolve) => {
        resolvers.set(input.toolCallId, resolve);
        set(input.toolCallId, { phase: "asking", ask: { chainId: tx.chainId, rpc } });
      });
    };

    return runAction(input.action, input.intent, {
      account: input.account,
      chainId: input.chainId,
      client: input.client,
      send,
      waitForReceipt: async (hash) => {
        const receipt = await input.client.waitForTransactionReceipt({ hash });
        return { status: receipt.status, logs: (receipt.logs ?? []).map((log) => ({ address: log.address, topics: log.topics, data: log.data })) };
      },
      onEvent: (event) => {
        if (event.type === "submitted") set(input.toolCallId, { phase: "confirming", hashes: [...(runs.get(input.toolCallId)?.hashes ?? []), event.hash] });
      },
    }).catch((): ActionResult => ({ status: "failed", hashes: runs.get(input.toolCallId)?.hashes ?? [], code: "UNEXPECTED", message: "The action stopped unexpectedly." }));
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get: (toolCallId: string) => runs.get(toolCallId),
    /** Runs of this view that are not finished. While there are any, the view should not send a new message. */
    activeCount(owner: object): number {
      let count = 0;
      for (const [id, run] of runs) if (run.phase !== "done" && owners.get(id) === owner) count += 1;
      return count;
    },
    start(input: StartActionRun): void {
      if (runs.has(input.toolCallId)) return; // once, ever
      runs.set(input.toolCallId, { phase: "queued", chainId: input.chainId, index: 0, total: 1, ask: null, hashes: [], result: null });
      owners.set(input.toolCallId, input.owner);
      for (const listener of listeners) listener();
      queue = queue.then(async () => {
        const result: ActionResult = { ...(await execute(input)), chainId: input.chainId };
        set(input.toolCallId, { phase: "done", ask: null, result });
        forgetOldest();
        if (!detached.has(input.owner)) input.report(result);
      });
    },
    /** The confirm frame's answer, or the person's Cancel, for a run that is asking. */
    answer,
    /** The view is (back) on screen. React mounts, unmounts and mounts again in development; the last word must be this one. */
    attach(owner: object): void {
      detached.delete(owner);
    },
    /** The view is going away. Its asks are dismissed and its runs will report nothing. */
    detach(owner: object): void {
      detached.add(owner);
      for (const [id, run] of runs) if (run.phase === "asking" && owners.get(id) === owner) answer(id, { kind: "denied" });
    },
  };
}

const actionRuns = createActionRuns({ request: (chainId, rpc) => walletFrame.request(chainId, rpc) as Promise<Hex> });

export const startActionRun = actionRuns.start;
export const answerAsk = actionRuns.answer;
export const attachActionRuns = actionRuns.attach;
export const detachActionRuns = actionRuns.detach;

export function useActionRun(toolCallId: string): ActionRunState | undefined {
  return useSyncExternalStore(actionRuns.subscribe, () => actionRuns.get(toolCallId), () => undefined);
}

/** How many of this view's actions are still in progress. */
export function useActiveActionRuns(owner: object): number {
  return useSyncExternalStore(actionRuns.subscribe, () => actionRuns.activeCount(owner), () => 0);
}
