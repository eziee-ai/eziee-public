import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

const OPENAI_PREFIX = "openai/";

/**
 * Who serves a model. An `openai/*` model goes straight to OpenAI when OPENAI_API_KEY is set (server only: never a
 * NEXT_PUBLIC_ name); every other model, and OpenAI's without that key, goes through the Vercel AI Gateway.
 * Billing does not change with the route: the price is the gateway's listing either way (packages/agent/src/models.ts).
 */
export function languageModelFor(id: string, env: Record<string, string | undefined> = process.env): LanguageModel {
  if (id.startsWith(OPENAI_PREFIX) && env.OPENAI_API_KEY) return createOpenAI({ apiKey: env.OPENAI_API_KEY })(id.slice(OPENAI_PREFIX.length));
  return id;
}
