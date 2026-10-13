import { describe, expect, it, vi } from "vitest";
import { ProtocolError } from "@repo/protocols/errors";
import type { AdapterAction, TxRequest } from "@repo/protocols/types";
import { z } from "zod";
import { runAction, type ActionEvent, type WalletAnswer } from "./runAction";

const APPROVE: TxRequest = { chainId: 5042002, to: "0x0000000000000000000000000000000000000201", data: "0x095ea7b3aa", value: 0n };
const SWAP: TxRequest = { chainId: 5042002, to: "0x0000000000000000000000000000000000000101", data: "0x5a01", value: 0n };
const ACCOUNT = "0x0000000000000000000000000000000000001001" as const;

function action(patch: Partial<AdapterAction<{ amount: string }>> = {}): AdapterAction<{ amount: string }> {
  return { description: "test", intent: z.object({ amount: z.string().regex(/^\d+$/) }), build: async () => [APPROVE, SWAP], simulate: async (txs) => (txs.length === 2 ? { ok: true, deferred: [1] } : { ok: true }), ...patch };
}

function harness(answers: WalletAnswer[], receipts: Array<"success" | "reverted"> = ["success", "success"]) {
  const events: ActionEvent[] = [];
  const send = vi.fn(async () => answers.shift() ?? ({ kind: "failed", message: "no more answers" } as WalletAnswer));
  const waitForReceipt = vi.fn(async () => receipts.shift() ?? "success");
  return { events, send, waitForReceipt, deps: { account: ACCOUNT, chainId: 5042002, client: {} as never, send, waitForReceipt, onEvent: (e: ActionEvent) => events.push(e) } };
}

describe("runAction", () => {
  it("sends each transaction in order, waits for each receipt, and reports confirmed with every hash", async () => {
    const h = harness([{ kind: "submitted", hash: "0xa1" }, { kind: "submitted", hash: "0xb2" }]);
    expect(await runAction(action(), { amount: "5" }, h.deps)).toEqual({ status: "confirmed", hashes: ["0xa1", "0xb2"] });
    expect(h.send.mock.calls.map((c) => (c as unknown as [TxRequest])[0].to)).toEqual([APPROVE.to, SWAP.to]);
    expect(h.events.map((e) => e.type)).toEqual(["building", "simulated", "asking", "submitted", "mined", "simulated", "asking", "submitted", "mined"]);
  });

  it("asks the action what the last receipt really did: success that moved nothing is 'unfilled', not 'confirmed'", async () => {
    const LOG = { address: "0x0000000000000000000000000000000000000301" as const, topics: ["0x01" as const], data: "0x" as const };
    const outcome = vi.fn(async (_intent: { amount: string }, logs: readonly unknown[]) => (logs.length > 0 ? { filled: true, message: "Received 990 DEMO.", facts: { Coin: "0xabc" } } : { filled: false, message: "Nothing was bought." }));
    const filled = harness([{ kind: "submitted", hash: "0xa1" }, { kind: "submitted", hash: "0xb2" }]);
    filled.waitForReceipt.mockImplementation(async () => ({ status: "success" as const, logs: [LOG] }) as never);
    expect(await runAction(action({ outcome }), { amount: "5" }, filled.deps)).toEqual({ status: "confirmed", hashes: ["0xa1", "0xb2"], message: "Received 990 DEMO.", facts: { Coin: "0xabc" } });
    // It was handed the parsed intent and the LAST receipt's logs.
    expect(outcome.mock.calls[0]![0]).toEqual({ amount: "5" });

    const empty = harness([{ kind: "submitted", hash: "0xa1" }, { kind: "submitted", hash: "0xb2" }]);
    empty.waitForReceipt.mockImplementation(async () => ({ status: "success" as const, logs: [] }) as never);
    expect(await runAction(action({ outcome }), { amount: "5" }, empty.deps)).toEqual({ status: "unfilled", hashes: ["0xa1", "0xb2"], message: "Nothing was bought." });
  });

  it("re-simulates a deferred transaction AFTER its approval is mined, and stops if it would now revert", async () => {
    const simulate = vi.fn(async (txs: TxRequest[]) => (txs.length === 2 ? { ok: true, deferred: [1] } : { ok: false, reason: "execution reverted: slippage" }));
    const h = harness([{ kind: "submitted", hash: "0xa1" }]);
    expect(await runAction(action({ simulate }), { amount: "5" }, h.deps)).toEqual({ status: "failed", hashes: ["0xa1"], code: "SIMULATION_FAILED", message: "execution reverted: slippage" });
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it("stops at a denial: nothing after it is sent, and the model is told 'denied'", async () => {
    const h = harness([{ kind: "denied" }]);
    expect(await runAction(action(), { amount: "5" }, h.deps)).toEqual({ status: "denied", hashes: [] });
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it("stops when a transaction reverts onchain and says which", async () => {
    const h = harness([{ kind: "submitted", hash: "0xa1" }, { kind: "submitted", hash: "0xb2" }], ["success", "reverted"]);
    expect(await runAction(action(), { amount: "5" }, h.deps)).toEqual({ status: "reverted", hashes: ["0xa1", "0xb2"], message: expect.stringContaining("reverted onchain") });
  });

  it("never reaches the wallet when the first simulation fails", async () => {
    const h = harness([]);
    const out = await runAction(action({ simulate: async () => ({ ok: false, reason: "insufficient balance" }) }), { amount: "5" }, h.deps);
    expect(out).toEqual({ status: "failed", hashes: [], code: "SIMULATION_FAILED", message: "insufficient balance" });
    expect(h.send).not.toHaveBeenCalled();
  });

  it("reports an invalid intent and a protocol error with their codes, without touching the wallet", async () => {
    const h = harness([]);
    expect(await runAction(action(), { amount: "five" }, h.deps)).toMatchObject({ status: "failed", code: "INVALID_INTENT" });
    const moved = action({ build: async () => { throw new ProtocolError("QUOTE_MOVED", "The price moved"); } });
    expect(await runAction(moved, { amount: "5" }, h.deps)).toEqual({ status: "failed", hashes: [], code: "QUOTE_MOVED", message: "The price moved" });
    expect(h.send).not.toHaveBeenCalled();
  });

  it("does not hand the wallet a quote that has gone stale while the person was reading", async () => {
    let now = 1_000;
    const h = harness([{ kind: "submitted", hash: "0xa1" }]);
    // The approval goes out in time; by the time it is mined the quote behind the swap has expired.
    const waitForReceipt = vi.fn(async () => ((now = 10_000), "success" as const));
    const out = await runAction(action({ expiresAt: () => 5_000 }), { amount: "5" }, { ...h.deps, waitForReceipt, now: () => now });
    expect(out).toMatchObject({ status: "failed", code: "QUOTE_EXPIRED", hashes: ["0xa1"] });
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it("says so when there was nothing to send, rather than blaming the network", async () => {
    const h = harness([]);
    expect(await runAction(action({ build: async () => [] }), { amount: "5" }, h.deps)).toMatchObject({ status: "failed", code: "NOTHING_TO_DO" });
    expect(h.send).not.toHaveBeenCalled();
  });

  it("refuses a built transaction for another chain, so a bad adapter cannot redirect the wallet", async () => {
    const h = harness([]);
    const out = await runAction(action({ build: async () => [{ ...SWAP, chainId: 1 }] }), { amount: "5" }, h.deps);
    expect(out).toMatchObject({ status: "failed", code: "WRONG_CHAIN" });
    expect(h.send).not.toHaveBeenCalled();
  });

  it("reports a wallet failure as failed, keeping what was already sent", async () => {
    const h = harness([{ kind: "submitted", hash: "0xa1" }, { kind: "failed", message: "Your passkey session has expired." }]);
    expect(await runAction(action(), { amount: "5" }, h.deps)).toEqual({ status: "failed", hashes: ["0xa1"], code: "WALLET", message: "Your passkey session has expired." });
  });
});
