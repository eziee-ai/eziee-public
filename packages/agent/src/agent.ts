import { ToolLoopAgent, isStepCount, type LanguageModel, type ToolSet } from "ai";
import type { Budget, BudgetStep } from "./budget";
import { MAX_OUTPUT_TOKENS, MAX_STEPS } from "./limits";

// Kept in their own module so billing code can read them without loading the model SDK.
export { MAX_OUTPUT_TOKENS, MAX_STEPS };

/**
 * One agent per request: the model, the network, the wallet and the protocol
 * scope all come from that request, so there is nothing to share between users.
 */
export function createTradingAgent(input: { model: LanguageModel; instructions: string; tools: ToolSet; /** Ends the loop before a step that might not fit in the credit held for this turn. */ budget?: Budget }) {
  const { budget } = input;
  return new ToolLoopAgent({
    model: input.model,
    instructions: input.instructions,
    tools: input.tools,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    stopWhen: budget ? [isStepCount(MAX_STEPS), ({ steps }) => budget.shouldStop(steps as unknown as BudgetStep[])] : isStepCount(MAX_STEPS),
  });
}
