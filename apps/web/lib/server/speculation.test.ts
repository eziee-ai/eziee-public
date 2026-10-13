import { describe, expect, it } from "vitest";
import type { BilledUsage } from "@repo/agent";
import { pumpSpeculative, stepCharges, type SpeculationTurn } from "./speculation";

type Chunk = { type: string; id?: string };

/**
 * A reader the test drives by hand: each entry is a chunk to hand over, `"end"` to finish, or `"throw"` to break
 * the stream. `onRead` runs just before each answer, which is where a test switches the turn mid-flight.
 */
function reader(script: Array<Chunk | "end" | "throw">, onRead?: (index: number) => void) {
  let index = 0;
  return {
    read: async () => {
      onRead?.(index);
      const step = script[index++];
      if (step === undefined || step === "end") return { done: true };
      if (step === "throw") throw new Error("the stream broke");
      return { done: false, value: step };
    },
  };
}

const turnOf = (over: Partial<SpeculationTurn> = {}): SpeculationTurn => ({ committed: false, switched: false, ...over });

describe("pumpSpeculative", () => {
  it("holds the opening chunks back, flushes them at the first chunk that carries anything, then passes the rest straight through", async () => {
    const written: Chunk[] = [];
    const turn = turnOf();
    await pumpSpeculative({ reader: reader([{ type: "start" }, { type: "start-step" }, { type: "text-start", id: "t" }, { type: "text-delta", id: "t" }, { type: "finish" }, "end"]), write: (c: Chunk) => written.push(c), turn });
    expect(written.map((c) => c.type)).toEqual(["start", "start-step", "text-start", "text-delta", "finish"]);
    expect(turn.committed).toBe(true);
  });

  it("says it has committed once, and not before the held-back chunks are out", async () => {
    const commits: number[] = [];
    const written: Chunk[] = [];
    await pumpSpeculative({
      reader: reader([{ type: "start" }, { type: "start-step" }, { type: "text-start" }, { type: "text-delta" }, "end"]),
      write: (c: Chunk) => written.push(c),
      turn: turnOf(),
      onCommit: () => commits.push(written.length),
    });
    // Once, with the two held-back chunks already written: whoever is waiting on this wakes to a stream in order.
    expect(commits).toEqual([2]);
  });

  it("drops a chunk that was already in flight when the turn switched, and writes nothing more", async () => {
    const written: Chunk[] = [];
    const turn = turnOf();
    // The turn switches while the read that would carry the model's first word is in flight.
    await pumpSpeculative({ reader: reader([{ type: "start" }, { type: "text-start" }, { type: "text-delta" }, "end"], (index) => { if (index === 1) turn.switched = true; }), write: (c: Chunk) => written.push(c), turn });
    expect(written).toEqual([]);
    expect(turn.committed).toBe(false);
  });

  it("writes nothing when the stream breaks AFTER the turn switched", async () => {
    const written: Chunk[] = [];
    const turn = turnOf();
    // A switched turn has already had its own `start` written. A second one would split the reply in two.
    await pumpSpeculative({ reader: reader([{ type: "start" }, "throw"], (index) => { if (index === 1) turn.switched = true; }), write: (c: Chunk) => written.push(c), turn });
    expect(written).toEqual([]);
    expect(turn.committed).toBe(false);
  });

  it("commits when the stream breaks BEFORE a switch, so the turn cannot hang on chunks nobody will send", async () => {
    const written: Chunk[] = [];
    const commits: string[] = [];
    const turn = turnOf();
    await pumpSpeculative({ reader: reader([{ type: "start" }, { type: "start-step" }, "throw"]), write: (c: Chunk) => written.push(c), turn, onCommit: () => commits.push("committed") });
    expect(written.map((c) => c.type)).toEqual(["start", "start-step"]);
    expect(turn.committed).toBe(true);
    expect(commits).toEqual(["committed"]);
  });

  it("commits when a stream that only ever said `start` ends", async () => {
    const written: Chunk[] = [];
    const turn = turnOf();
    await pumpSpeculative({ reader: reader([{ type: "start" }, "end"]), write: (c: Chunk) => written.push(c), turn });
    expect(written.map((c) => c.type)).toEqual(["start"]);
    expect(turn.committed).toBe(true);
  });

  it("never holds anything back once the turn has committed", async () => {
    const written: Chunk[] = [];
    await pumpSpeculative({ reader: reader([{ type: "text-delta" }, { type: "start-step" }, { type: "text-delta" }, "end"]), write: (c: Chunk) => written.push(c), turn: turnOf() });
    expect(written.map((c) => c.type)).toEqual(["text-delta", "start-step", "text-delta"]);
  });
});

describe("stepCharges", () => {
  function charging(turn: SpeculationTurn) {
    const charged: BilledUsage[] = [];
    const recorded: Array<{ inputTokens: number; estimated: boolean }> = [];
    return { charged, recorded, ...stepCharges({ turn, charge: (usage) => charged.push(usage), record: (record) => recorded.push(record) }) };
  }

  it("charges a step of the speculative call exactly as an ordinary step while the turn has not switched", () => {
    const { speculative, charged, recorded } = charging(turnOf());
    speculative({ inputTokens: 1000, outputTokens: 200 });
    expect(charged).toEqual([{ inputTokens: 1000, outputTokens: 200 }]);
    expect(recorded).toEqual([]); // nothing was given up on, so there is nothing to say about a call given up on
  });

  it("charges the call the turn gave up on at its own real usage when that call reports a step, and the restarted call then adds nothing more (spec R9)", () => {
    const { speculative, restarted, charged, recorded } = charging(turnOf({ switched: true }));
    speculative({ inputTokens: 900, outputTokens: 40 });
    restarted({ inputTokens: 1000, outputTokens: 200 });
    // Two charges for two calls, never three: the abandoned call was measured by itself, so the restarted call
    // pays for nothing but itself.
    expect(charged).toEqual([{ inputTokens: 900, outputTokens: 40 }, { inputTokens: 1000, outputTokens: 200 }]);
    expect(recorded).toEqual([{ inputTokens: 900, estimated: false }]);
  });

  it("charges the abandoned call by the restarted call's own first step when it reported none, once (spec R9)", () => {
    const { restarted, charged, recorded } = charging(turnOf({ switched: true }));
    restarted({ inputTokens: 1000, outputTokens: 200 });
    restarted({ inputTokens: 1500, outputTokens: 100 });
    expect(charged).toEqual([{ inputTokens: 1000, outputTokens: 200 }, { inputTokens: 1000, outputTokens: 0 }, { inputTokens: 1500, outputTokens: 100 }]);
    expect(recorded).toEqual([{ inputTokens: 1000, estimated: false }]);
  });

  it("charges nothing for the abandoned call when neither call ever ends a step", () => {
    const { charged, recorded } = charging(turnOf({ switched: true }));
    expect(charged).toEqual([]);
    expect(recorded).toEqual([]);
  });
});
