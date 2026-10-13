import { availableModels } from "@repo/agent/models";
import { MAX_OUTPUT_TOKENS } from "@repo/agent/limits";
import { holdMicrousd, type ModelPrice } from "@repo/agent/pricing";
import { testHooksEnabled } from "../testHooks";
import { marginBps, minHoldMicrousd } from "./config";

/**
 * What one send of the default model needs to be spendable, before the chat has said so itself (spec §14.2).
 * A message is refused unless the account can hold one worst-case call: its prompt, plus the most the model may
 * write, at the model's price and margin. That is what the chat checks; this is the same sum, for the browser.
 */

/** A first message's prompt: the instructions and the tools' schemas, measured at about 11k tokens, rounded up. */
export const SEND_FLOOR_PROMPT_TOKENS = 12_000;
/** The session answers every page. It waits this long for a price, and otherwise leaves the floor out. */
const WAIT_MS = 1_500;

async function defaultModelPrice(): Promise<ModelPrice | null> {
  // End-to-end tests price the scripted model, not whatever the live gateway says today.
  if (testHooksEnabled()) return (await import("../mockModel")).MOCK_MODEL_INFO.price;
  return (await availableModels()).find((model) => model.isDefault)?.price ?? null;
}

/** In micro-USD, or null when the price cannot be had in time or a billing value cannot be read. */
export async function defaultSendFloor(options: { price?: () => Promise<ModelPrice | null>; waitMs?: number } = {}): Promise<bigint | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const late = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), options.waitMs ?? WAIT_MS)));
    const price = await Promise.race([(options.price ?? defaultModelPrice)(), late]);
    if (!price) return null;
    return holdMicrousd(price, { estimatedInputTokens: SEND_FLOOR_PROMPT_TOKENS, maxOutputTokens: MAX_OUTPUT_TOKENS, maxSteps: 1, marginBps: marginBps(), minimum: minHoldMicrousd() });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
