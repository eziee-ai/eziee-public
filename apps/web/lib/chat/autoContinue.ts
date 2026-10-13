import { getToolName, isToolUIPart, lastAssistantMessageIsCompleteWithToolCalls, type UIMessage } from "ai";

/**
 * When the browser may send the conversation back to the model without the person asking.
 *
 * There is exactly one good reason: the model asked the BROWSER to do something (run an action, open a screen),
 * the browser has now answered, and the model has not seen the answer yet.
 *
 * The SDK's own rule is broader. It continues whenever the last step's tool calls all have results, which is also
 * what a reply looks like when the SERVER cut a tool loop short (its step limit, or the credit held for the
 * message). Continuing then would open a fresh hold and a fresh loop, again and again, with nobody asking. So a
 * last step made only of server tools never continues, and automatic turns are capped per thing the person said.
 *
 * Not every browser tool wants an answer read, either. "Open the deposit screen" is the END of a turn: the person
 * is leaving this view, and a follow-up request would be billed for a reply that arrives after they have gone.
 * So the caller says which tools the model is actually WAITING on, and only those continue.
 */
export const MAX_AUTO_CONTINUES = 4;

export function createAutoContinue(modelAwaits: (toolName: string) => boolean) {
  let turns = 0;
  return {
    /** The person sent a message: the count starts over. */
    personSpoke(): void {
      turns = 0;
    },
    shouldContinue({ messages }: { messages: UIMessage[] }): boolean {
      if (!lastAssistantMessageIsCompleteWithToolCalls({ messages })) return false;
      const parts = messages[messages.length - 1]?.parts ?? [];
      const lastStep = parts.slice(parts.reduce((at, part, index) => (part.type === "step-start" ? index : at), -1) + 1);
      if (!lastStep.some((part) => isToolUIPart(part) && modelAwaits(getToolName(part)))) return false;
      if (turns >= MAX_AUTO_CONTINUES) return false;
      turns += 1;
      return true;
    },
  };
}
