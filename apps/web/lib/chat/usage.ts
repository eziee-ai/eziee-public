import { formatUsd } from "@repo/agent/pricing";

/**
 * What a chat has used, read from the metadata the server puts on each reply (lib/server/chat.ts `ChatMetadata`).
 * The browser only adds up what the server says it did; it never estimates on its own.
 */

/** The part of a reply's metadata this file reads. Names match the server's `ChatMetadata`. */
export interface UsageMetadata {
  model?: string;
  /** Micro-USD, as a string because it is a bigint. */
  costMicrousd?: string;
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
  contextTokens?: number;
  contextWindow?: number;
  trimmed?: number;
  /** Micro-USD the account must be able to hold for the next message like this one to be sent. */
  sendFloorMicrousd?: string;
}

export interface ChatUsage {
  /** Tokens in plus tokens out, over every reply. Cache reads are part of the tokens in. */
  tokens: number;
  costMicrousd: bigint;
  /** Replies that finished and were charged. */
  replies: number;
  /** The prompt size of the latest reply that reported one, against its model's window. */
  last?: { contextTokens: number; contextWindow: number };
}

type Row = { role: string; metadata?: UsageMetadata };

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0);
const micro = (value: unknown): bigint | null => (typeof value === "string" && /^[0-9]{1,18}$/.test(value) ? BigInt(value) : null);

export function chatUsage(messages: readonly Row[]): ChatUsage {
  const total: ChatUsage = { tokens: 0, costMicrousd: 0n, replies: 0 };
  for (const { role, metadata } of messages) {
    if (role !== "assistant" || !metadata) continue;
    const cost = typeof metadata.costMicrousd === "string" ? micro(metadata.costMicrousd) : null;
    if (typeof metadata.costMicrousd === "string") total.replies += 1;
    if (cost !== null) total.costMicrousd += cost;
    if (metadata.usage) total.tokens += count(metadata.usage.inputTokens) + count(metadata.usage.outputTokens);
    if (count(metadata.contextTokens) > 0 && count(metadata.contextWindow) > 0) total.last = { contextTokens: count(metadata.contextTokens), contextWindow: count(metadata.contextWindow) };
  }
  return total;
}

/** "340", "1.2k", "1.0M". */
export function formatTokens(n: number): string {
  const value = count(n);
  if (value < 1_000) return String(value);
  // 999,950 would round to "1000.0k"; from there on it is millions.
  if (value < 999_950) return `${(value / 1_000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

/** The line under a reply: which model, what went in and out, and what it cost. */
export function replyLine(metadata: UsageMetadata & { costMicrousd: string }): string {
  const model = metadata.model?.split("/")[1] ?? "model";
  const cost = formatUsd(micro(metadata.costMicrousd) ?? 0n);
  if (!metadata.usage) return `${model} · this reply cost ${cost}`;
  return `${model} · ${formatTokens(metadata.usage.inputTokens)} in · ${formatTokens(metadata.usage.outputTokens)} out · ${cost}`;
}

/** How many of the oldest messages the latest reply was sent without. */
export function trimmedCount(messages: readonly Row[]): number {
  const latest = messages.findLast((message) => message.role === "assistant");
  return count(latest?.metadata?.trimmed);
}

/** What each finished reply in the chat cost, in micro-USD. */
export function replyCosts(messages: readonly Row[]): bigint[] {
  return messages.flatMap(({ role, metadata }) => {
    const cost = role === "assistant" ? micro(metadata?.costMicrousd) : null;
    return cost === null ? [] : [cost];
  });
}

/** What the latest reply said one more send needs held, or null before any reply has said so. */
export function latestSendFloor(messages: readonly Row[]): bigint | null {
  const latest = messages.findLast((message) => message.role === "assistant" && message.metadata?.sendFloorMicrousd !== undefined);
  return micro(latest?.metadata?.sendFloorMicrousd);
}
