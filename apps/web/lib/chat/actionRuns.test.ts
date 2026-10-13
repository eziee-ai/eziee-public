import type { Address, Hex, PublicClient } from "viem";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AdapterAction, TxRequest } from "@repo/protocols/types";
import { ERR } from "@repo/wallet/frame/protocol";
import { createActionRuns, MAX_KEPT_RUNS } from "./actionRuns";

const ALICE = "0x0000000000000000000000000000000000001001" as Address;
const CHAIN = 5042002;
const tx = (n: number): TxRequest => ({ chainId: CHAIN, to: `0x${String(n).padStart(40, "0")}` as Address, data: "0x", value: 0n });
const hash = (n: number) => `0x${String(n).padStart(64, "0")}` as Hex;

const action = (txs: TxRequest[]): AdapterAction<unknown> => ({ description: "", intent: z.unknown(), build: async () => txs, simulate: async () => ({ ok: true }) });
const client = { waitForTransactionReceipt: async () => ({ status: "success" as const }) } as unknown as PublicClient;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(request: (chainId: number, rpc: unknown) => Promise<Hex>) {
  const runs = createActionRuns({ request: vi.fn(request) as never });
  const start = (id: string, owner: object, txs: TxRequest[], report = vi.fn()) => {
    runs.start({ toolCallId: id, owner, action: action(txs), intent: {}, account: ALICE, chainId: CHAIN, client, gasSymbol: "USDC", report });
    return report;
  };
  return { runs, start };
}
const needsConfirm = async () => Promise.reject({ code: ERR.CONFIRM_REQUIRED, message: "ask" });

describe("action runs", () => {
  it("signs silently under a rule, reports the result once, and keeps it for the card", async () => {
    const { runs, start } = setup(async () => hash(1));
    const report = start("a", {}, [tx(1)]);
    await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(1));
    expect(report).toHaveBeenCalledWith({ status: "confirmed", hashes: [hash(1)], chainId: CHAIN });
    expect(runs.get("a")).toMatchObject({ phase: "done", chainId: CHAIN, result: { status: "confirmed" } });
  });

  it("never runs the same tool call twice", async () => {
    const { runs, start } = setup(async () => hash(1));
    const first = start("a", {}, [tx(1)]);
    const second = start("a", {}, [tx(1)]);
    await vi.waitFor(() => expect(first).toHaveBeenCalled());
    await tick();
    expect(second).not.toHaveBeenCalled();
    expect(runs.get("a")?.hashes).toEqual([hash(1)]);
  });

  it("runs ONE at a time: a second action waits, so two wallet prompts and two nonces never race", async () => {
    const { runs, start } = setup(needsConfirm);
    const owner = {};
    start("a", owner, [tx(1)]);
    start("b", owner, [tx(2)]);
    await vi.waitFor(() => expect(runs.get("a")?.phase).toBe("asking"));
    expect(runs.get("b")?.phase).toBe("queued");
    expect(runs.activeCount(owner)).toBe(2);

    runs.answer("a", { kind: "submitted", hash: hash(1) });
    await vi.waitFor(() => expect(runs.get("b")?.phase).toBe("asking"));
    expect(runs.get("a")?.phase).toBe("done");
    runs.answer("b", { kind: "denied" });
    await vi.waitFor(() => expect(runs.activeCount(owner)).toBe(0));
  });

  it("after its view is gone, a run that finishes reports NOTHING (a report would start a billed request nobody sees) but keeps its result", async () => {
    let release!: (h: Hex) => void;
    const { runs, start } = setup(() => new Promise<Hex>((resolve) => (release = resolve)));
    const owner = {};
    const report = start("a", owner, [tx(1)]);
    await tick();
    runs.detach(owner);
    release(hash(1));
    await vi.waitFor(() => expect(runs.get("a")?.phase).toBe("done"));
    expect(report).not.toHaveBeenCalled();
    expect(runs.get("a")?.result).toEqual({ status: "confirmed", hashes: [hash(1)], chainId: CHAIN });
  });

  it("a view that comes back (React mounts twice in development) reports again", async () => {
    const { runs, start } = setup(async () => hash(1));
    const owner = {};
    runs.detach(owner);
    runs.attach(owner);
    const report = start("a", owner, [tx(1)]);
    await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(1));
  });

  it("when its view goes while the wallet is asking, the ask is dismissed: the run ends, nothing is signed, nothing hangs", async () => {
    const { runs, start } = setup(needsConfirm);
    const owner = {};
    const report = start("a", owner, [tx(1), tx(2)]);
    await vi.waitFor(() => expect(runs.get("a")?.phase).toBe("asking"));
    runs.detach(owner);
    await vi.waitFor(() => expect(runs.get("a")?.phase).toBe("done"));
    expect(runs.get("a")).toMatchObject({ ask: null, result: { status: "denied", hashes: [] } });
    expect(report).not.toHaveBeenCalled();
  });

  it("a queued run whose view is gone before its turn never builds or asks", async () => {
    const { runs, start } = setup(needsConfirm);
    const owner = {};
    start("a", owner, [tx(1)]);
    const build = vi.fn(async () => [tx(2)]);
    runs.start({ toolCallId: "b", owner, action: { ...action([]), build }, intent: {}, account: ALICE, chainId: CHAIN, client, gasSymbol: "USDC", report: vi.fn() });
    await vi.waitFor(() => expect(runs.get("a")?.phase).toBe("asking"));
    runs.detach(owner);
    await vi.waitFor(() => expect(runs.get("b")?.phase).toBe("done"));
    expect(build).not.toHaveBeenCalled();
    expect(runs.get("b")?.result).toMatchObject({ status: "failed", code: "CANCELLED" });
  });

  it("the person can cancel an ask from the chat, which counts as a denial", async () => {
    const { runs, start } = setup(needsConfirm);
    const report = start("a", {}, [tx(1)]);
    await vi.waitFor(() => expect(runs.get("a")?.phase).toBe("asking"));
    runs.answer("a", { kind: "denied" });
    await vi.waitFor(() => expect(report).toHaveBeenCalledWith({ status: "denied", hashes: [], chainId: CHAIN }));
  });

  it("forgets the oldest finished runs rather than growing for the life of the tab", async () => {
    const { runs, start } = setup(async () => hash(1));
    const owner = {};
    for (let i = 0; i < MAX_KEPT_RUNS + 5; i++) start(`r${i}`, owner, [tx(1)]);
    await vi.waitFor(() => expect(runs.activeCount(owner)).toBe(0), { timeout: 5000 });
    expect(runs.get("r0")).toBeUndefined();
    expect(runs.get(`r${MAX_KEPT_RUNS + 4}`)?.phase).toBe("done");
  });
});
