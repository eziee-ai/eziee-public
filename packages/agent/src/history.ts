import type { UIMessage } from "ai";

/**
 * What of a chat the model is sent (spec §7). The browser sends the whole chat every turn and all of it is saved;
 * the model gets the newest part that fits its window. Only the prompt is trimmed, never the transcript.
 *
 * A cut lands only where a message from the person begins. A reply can hold tool calls whose results live in the
 * same reply, so starting the kept history on a reply could hand the model a result without its call, or the
 * reverse. Starting on the person's message keeps every call beside its result.
 */

/** No model is sent more than this, whatever its window: a longer prompt costs more and rarely answers better. */
const MAX_CONTEXT_TOKENS = 200_000;
/**
 * How many tokens of conversation a turn may send: the window, capped, less what the instructions, tools and reply
 * take. Never more than the window leaves: when that is nothing, `trimHistory` still keeps the newest question.
 */
export function contextBudget(contextWindow: number, reserved: number): number {
  return Math.max(0, Math.min(contextWindow, MAX_CONTEXT_TOKENS) - reserved);
}

/**
 * The newest messages that fit in `maxTokens`, and how many older ones were left out.
 *
 * INVARIANT: the last message is always kept, and the kept list starts on a message from the person (or is the
 * whole history). When even the last message from the person does not fit, it is kept anyway, with what follows it.
 */
export function trimHistory(input: { messages: UIMessage[]; maxTokens: number; estimate: (messages: UIMessage[]) => number }): { messages: UIMessage[]; dropped: number } {
  const { messages, maxTokens, estimate } = input;
  // Where a cut may land: the start, and every message from the person. Later cuts keep less.
  const cuts = [0, ...messages.flatMap((message, index) => (index > 0 && message.role === "user" ? [index] : []))];
  const lastUser = messages.findLastIndex((message) => message.role === "user");
  if (lastUser < 0) return { messages, dropped: 0 };
  const fits = (cut: number) => estimate(messages.slice(cut)) <= maxTokens;
  if (fits(0)) return { messages, dropped: 0 };

  // A later cut never keeps more, so the estimate only falls along `cuts`: binary search for the earliest that fits.
  // A scan would re-measure the whole chat once per turn, which is quadratic on a long chat.
  let low = 1;
  let high = cuts.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (fits(cuts[middle]!)) {
      found = middle;
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }
  const cut = found >= 0 ? cuts[found]! : lastUser;
  return { messages: messages.slice(cut), dropped: cut };
}
