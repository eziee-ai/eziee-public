import { generateId, type UIMessage } from "ai";
import { decidePrerun, readRequest, toolName, type Reading } from "@repo/agent";
import type { AdapterContext, ProtocolAdapter, RankMeasure } from "@repo/protocols/types";

/**
 * The read the model was about to ask for, run BESIDE the model rather than in front of it (spec R8).
 *
 * The two halves are deliberately separate. `readRequestFor` only asks Jev what the message was, and is racing
 * the model; `runPrerun` runs the rank read, and is called only once the turn has decided to give up its
 * speculative model call. A reading that arrives too late therefore never costs a read at all.
 *
 * Neither half can fail a chat turn: every failure is `null`, which means "carry on as usual".
 */

const RANK_READ = "rank";
const PRERUN_LIMIT = 5;

export type RequestReader = (message: string, signal?: AbortSignal) => Promise<Reading | null>;

export interface Prerun {
  toolName: string;
  toolCallId: string;
  input: { measure: RankMeasure; limit: number };
  output: unknown;
  /** The assistant message the agent continues: a step that already holds the finished rank call. */
  message: UIMessage;
}

export interface RequestReading {
  /** Recorded in the settlement whether or not a pre-run follows: Jev's cost is absorbed, but not invisible (spec R6). */
  usage: { model: string; inputTokens: number; outputTokens: number };
  /** What to tell the person the reading was, shown only when a pre-run follows. */
  router: { intent: string; measure: string; confidence: number; ms: number };
  /** The measure to rank by, or null when the reading was not confident enough to act on. */
  measure: RankMeasure | null;
}

/** Off unless the deployment has a TypeSafe key. The key never leaves the server. */
export function readerFromEnv(): RequestReader | null {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) return null;
  return (message, signal) => readRequest({ message, apiKey, signal });
}

function lastUserText(messages: UIMessage[]): string | null {
  const last = messages.at(-1);
  if (last?.role !== "user") return null;
  const text = last.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join(" ")
    .trim();
  return text || null;
}

/** A skip is never an error to the person, so it is logged where an operator can find it and nowhere else. */
function skipped(error: unknown): null {
  // The error only. The text of the person's message is not in it, and must not be put in it.
  console.warn("[prerun] skipped", error);
  return null;
}

/**
 * What Jev makes of the person's last message. Null when there is nothing to ask about: no reader, the last
 * message is not the person's (the browser is answering a tool call), no protocol in scope can rank, or Jev
 * did not answer.
 */
export async function readRequestFor(input: { messages: UIMessage[]; adapters: readonly ProtocolAdapter[]; read: RequestReader | null; signal?: AbortSignal }): Promise<RequestReading | null> {
  try {
    if (!input.read) return null;
    const text = lastUserText(input.messages);
    if (!text || !input.adapters.some((a) => a.reads[RANK_READ])) return null;
    const reading = await input.read(text, input.signal);
    if (!reading) return null;
    return {
      usage: { model: reading.model, ...reading.usage },
      router: { intent: reading.intent, measure: reading.measure, confidence: Math.min(reading.intentConfidence, reading.measureConfidence), ms: reading.ms },
      measure: decidePrerun(reading)?.measure ?? null,
    };
  } catch (error) {
    return skipped(error);
  }
}

/**
 * The rank read itself, as the step the model would have produced. `messageId` is the turn's own, so the part
 * lands on the one assistant message the browser is already building.
 */
export async function runPrerun(input: { adapters: readonly ProtocolAdapter[]; ctx: AdapterContext; measure: RankMeasure; messageId: string }): Promise<Prerun | null> {
  try {
    const adapter = input.adapters.find((a) => a.reads[RANK_READ]);
    if (!adapter) return null;
    const rankInput = { measure: input.measure, limit: PRERUN_LIMIT };
    const output: unknown = await adapter.reads[RANK_READ]!.run(rankInput, input.ctx);
    const name = toolName(adapter.id, RANK_READ);
    const toolCallId = `prerun-${generateId()}`;
    const message = { id: input.messageId, role: "assistant", parts: [{ type: "step-start" }, { type: `tool-${name}`, toolCallId, state: "output-available", input: rankInput, output }] } as UIMessage;
    return { toolName: name, toolCallId, input: rankInput, output, message };
  } catch (error) {
    // A pre-run is an optimisation. The turn goes on without it; the model can still call the read itself.
    return skipped(error);
  }
}
