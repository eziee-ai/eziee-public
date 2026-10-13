/**
 * Pumping the speculative model call (spec R8).
 *
 * The model is called at the same moment the person's request is read, so a turn has to be able to see what the
 * model has said before deciding whose answer it keeps. The model's opening chunks carry no words, so they are
 * held back; the first chunk that is not one of them COMMITS the turn to the model's own answer, and from then
 * on the reading cannot change it.
 *
 * The one invariant that has to hold everywhere, on every exit: once the turn has SWITCHED to a pre-run, this
 * writes nothing. A switched turn has already had its own `start` written, and a second one would split the
 * reply into two messages.
 */

import type { BilledUsage } from "@repo/agent";

/** Which way the turn has gone. Owned by the caller, because the caller is the other half of the race. */
export interface SpeculationTurn {
  /** The turn keeps the model's own answer. Set here, at the first chunk that carries anything. */
  committed: boolean;
  /** The caller gave this call up for a pre-run. Set by the caller, never here. */
  switched: boolean;
}

const PREAMBLE = new Set(["start", "start-step"]);

export async function pumpSpeculative<T extends { type: string }>(input: {
  reader: { read(): Promise<{ done: boolean; value?: T }> };
  /** Where a chunk goes when it is to be forwarded to the browser. */
  write: (chunk: T) => void;
  turn: SpeculationTurn;
  /** Called once, when the turn commits, so the caller can stop waiting on the reading. */
  onCommit?: () => void;
}): Promise<void> {
  const { reader, write, turn } = input;
  const preamble: T[] = [];
  const commit = () => {
    turn.committed = true;
    for (const chunk of preamble) write(chunk);
    preamble.length = 0;
    input.onCommit?.();
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      // FIRST, before anything is written: the turn may have switched while this read was in flight.
      if (turn.switched) return;
      if (done) break;
      if (!turn.committed && PREAMBLE.has(value!.type)) {
        preamble.push(value!);
        continue;
      }
      if (!turn.committed) commit();
      write(value!);
    }
  } catch {
    // The stream broke. The turn still has to end, so it ends as the ordinary one.
  }
  // Every exit but the switched one passes here — that one returns above, having written nothing, which is the
  // invariant itself. So this is where a turn that ended, was cancelled, or broke without switching commits.
  if (!turn.switched && !turn.committed) commit();
}

/**
 * Who pays for the call a switched turn gave up on (spec R9), as ONE rule rather than two callbacks that must
 * agree. A provider may bill a request it never answered, and `ai@7.0.107` reports no usage for a call aborted
 * before its first token — so the abandoned call is charged deliberately, from a measurement, exactly once.
 *
 * Whichever call measures it first wins, and the other then adds nothing:
 *  - the abandoned call's OWN step, if it ever ends one after the switch: its real usage, which is the truth;
 *  - otherwise the restarted call's first step, whose input count the provider's tokenizer has just measured on
 *    the same prompt bar the rank part, charged once more with no output.
 *
 * Both charges together would be one turn billed twice for one abandoned call. They are mutually exclusive here
 * by construction, rather than by the SDK's happening to order its chunks so that only one of them can fire.
 */
export function stepCharges(input: {
  turn: SpeculationTurn;
  /** The turn's ordinary charge, as every other step is charged. */
  charge: (usage: BilledUsage) => void;
  /** Where the settlement record's `meta.router.speculative` comes from. Called at most once. */
  record: (speculative: { inputTokens: number; estimated: false }) => void;
}): { speculative: (usage: BilledUsage) => void; restarted: (usage: BilledUsage) => void } {
  let owedForTheAbandonedCall = true;
  return {
    /** A step of the SPECULATIVE call. Before a switch it is an ordinary step of an ordinary turn. */
    speculative(usage) {
      input.charge(usage);
      if (!input.turn.switched || !owedForTheAbandonedCall) return;
      owedForTheAbandonedCall = false;
      input.record({ inputTokens: usage.inputTokens ?? 0, estimated: false });
    },
    /** A step of the RESTARTED call, the one that has the rank result in hand. */
    restarted(usage) {
      input.charge(usage);
      if (!owedForTheAbandonedCall) return;
      owedForTheAbandonedCall = false;
      const inputTokens = usage.inputTokens ?? 0;
      input.record({ inputTokens, estimated: false });
      input.charge({ inputTokens, outputTokens: 0 });
    },
  };
}
