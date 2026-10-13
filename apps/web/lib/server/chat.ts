import { createAgentUIStream, createAgentUIStreamResponse, createUIMessageStream, createUIMessageStreamResponse, generateId, safeValidateUIMessages, type LanguageModel, type UIMessage } from "ai";
import type { Address } from "viem";
import { z } from "zod";
import { buildTools, contextBudget, createBudget, createTradingAgent, estimatePromptTokens, holdMicrousd, MAX_OUTPUT_TOKENS, resolveModel, systemPrompt, trimHistory, type AvailableModel, type BilledUsage, type TokenUsage } from "@repo/agent";
import { createChat, getChat, placeHold, releaseStaleHolds, saveMessages, settleHold, updateChat, type Db } from "@repo/db";
import type { AdapterContext, ProtocolAdapter } from "@repo/protocols/types";
import { BRAND } from "@repo/ui/brand";
import { appChains } from "@/lib/chains";
import { enabledRails, marginBps, minHoldMicrousd } from "./billing/config";
import { problem } from "./http";
import { readerFromEnv, readRequestFor, runPrerun, type RequestReader, type RequestReading } from "./prerun";
import { clientFor, protocolSource } from "./protocolSource";
import { pumpSpeculative, stepCharges } from "./speculation";
import { refillFreeCredit } from "./testHooks";
import { languageModelFor } from "./languageModel";

/**
 * One chat turn, metered (spec §7, §14.2):
 *   hold → stream the agent → settle what it really cost → persist the transcript.
 *
 * The hold is placed BEFORE the model is called; with no spendable credit the
 * answer is HTTP 402 and no model call is made. Settlement happens when the
 * stream ends OR aborts, and charges at most the hold.
 *
 * What keeps the real cost inside the hold is the BUDGET (packages/agent/src/budget.ts):
 * the tool loop may not start a step whose worst case would not fit in what is left.
 */

// Read once, at load: a malformed value stops the chat with its name before any credit is held.
const MARGIN_BPS = marginBps();
const MIN_HOLD = minHoldMicrousd();
/**
 * The hold covers this many worst-case model calls. Real calls cost a small fraction of the worst case (the
 * worst case assumes the model writes its maximum every time), so in practice this lets a full tool loop run,
 * while a loop that really is expensive is ended by the budget before it can pass the hold.
 */
const HOLD_STEPS = 2;
/**
 * A hold this old cannot belong to a live request: the chat route's `maxDuration` is 120 seconds. It was left by a
 * request the platform killed mid-stream, and would otherwise lock that credit for good. Must stay far above
 * `maxDuration`, or a request still streaming would have its hold released and run free.
 */
export const STALE_HOLD_MS = 15 * 60_000;
/**
 * The browser sends the whole conversation each time, and the model is sent only what fits its window. Past this
 * many messages the request is refused, with a message that says what to do: the body would grow past its cap.
 */
const MAX_MESSAGES = 1_000;

export const chatBody = z.object({
  chatId: z.string().uuid().optional(),
  /** For a new chat only: the caller's folder to file it in. Someone else's folder is ignored by createChat. */
  folderId: z.string().uuid().optional(),
  model: z.string().min(1).max(100),
  protocol: z.string().regex(/^(auto|[a-z0-9][a-z0-9-]{0,31})$/),
  chainId: z.number().int().positive(),
  // The upper bound is checked separately, so it can have its own message.
  messages: z.array(z.unknown()).min(1),
});

export interface ChatMetadata {
  model?: string;
  /** Micro-USD, as a string because it is a bigint. */
  costMicrousd?: string;
  chatId?: string;
  /** The tool loop was ended to stay inside the credit held for this message. */
  stoppedForBudget?: boolean;
  /** What the request reader made of the message, when a read was run ahead of the model. */
  router?: RequestReading["router"];
  /** The tokens this reply used, summed over its model calls. */
  usage?: TokenUsage;
  /** The size, in tokens, of the prompt the last model call was sent: as the provider measured it, else as estimated. */
  contextTokens?: number;
  /** How many tokens the model's prompt may hold. */
  contextWindow?: number;
  /** How many of the oldest messages were not sent to the model this turn. They stay in the chat. */
  trimmed?: number;
  /** Micro-USD the account must be able to hold for the next message like this one to be sent at all. */
  sendFloorMicrousd?: string;
}

/** Said when a chat is past what one request may carry, by message count here or by size in the route. */
import { CHAT_TOO_LONG_MESSAGE } from "@/lib/chat/tooLong";
import { currentProtocolId, renameLegacyToolParts } from "@/lib/chat/legacyRate";
export { CHAT_TOO_LONG_MESSAGE };

const isTokenCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * What the earlier turns of a CONTINUED reply used. When the browser answers one of the reply's tool calls, the
 * reply is sent back and this turn streams onto the same message, whose finish metadata replaces the old. So the
 * earlier turns are added in here. It is the browser's copy, and it is only ever displayed, never charged: each
 * turn was settled against the ledger when it ended. Values that are not whole numbers are left out.
 */
function earlierTurns(last: UIMessage | undefined): { costMicrousd: bigint; usage: TokenUsage } {
  const none = { costMicrousd: 0n, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } };
  if (last?.role !== "assistant" || typeof last.metadata !== "object" || last.metadata === null) return none;
  const { costMicrousd, usage } = last.metadata as { costMicrousd?: unknown; usage?: Partial<Record<keyof TokenUsage, unknown>> };
  const count = (value: unknown) => (isTokenCount(value) ? value : 0);
  return {
    costMicrousd: typeof costMicrousd === "string" && /^[0-9]{1,18}$/.test(costMicrousd) ? BigInt(costMicrousd) : 0n,
    usage: typeof usage === "object" && usage !== null ? { inputTokens: count(usage.inputTokens), outputTokens: count(usage.outputTokens), cacheReadTokens: count(usage.cacheReadTokens) } : none.usage,
  };
}

function titleFrom(messages: UIMessage[]): string {
  const first = messages.find((m) => m.role === "user")?.parts.find((p) => p.type === "text");
  const text = first && "text" in first ? first.text.replace(/\s+/g, " ").trim() : "";
  return text.slice(0, 60) || "New chat";
}

const OPEN_TOOL_STATES = new Set(["input-streaming", "input-available"]);
const INTERRUPTED = "This action was interrupted before its result was recorded, so its outcome is unknown. A transaction that was already signed may have gone through. Do not repeat it unless the person asks; if they do, read the current state first.";

/**
 * A tool call the browser never answered: the person left, reloaded, or changed network while an action was open.
 * Left as it is, it would make every later request fail, because a model cannot be sent a tool call with no
 * result. It is closed as an error that tells the model the truth, which also makes it a terminal part, so a tool
 * that does not exist on the network now selected no longer fails validation either.
 */
export function closeInterruptedToolParts(messages: unknown[]): unknown[] {
  return messages.map((message) => {
    if (typeof message !== "object" || message === null || (message as { role?: unknown }).role !== "assistant" || !Array.isArray((message as { parts?: unknown }).parts)) return message;
    const parts = (message as { parts: unknown[] }).parts.map((part) => {
      if (typeof part !== "object" || part === null) return part;
      const { type, state } = part as { type?: unknown; state?: unknown };
      const isTool = typeof type === "string" && (type.startsWith("tool-") || type === "dynamic-tool");
      if (!isTool || typeof state !== "string" || !OPEN_TOOL_STATES.has(state)) return part;
      return { ...part, state: "output-error", input: (part as { input?: unknown }).input ?? {}, errorText: INTERRUPTED };
    });
    return { ...message, parts };
  });
}

type ChatInput = {
  db: Db;
  address: Address;
  body: unknown;
  signal?: AbortSignal;
  /** Tests inject a mock; production resolves the id through the gateway. */
  model?: { language: LanguageModel; info: AvailableModel };
  /** Tests inject these; production reads the environment and the registry. */
  read?: RequestReader | null;
  adapters?: readonly ProtocolAdapter[];
};

/** Whatever goes wrong, the answer has a code and no internals in it. Holds are released where they are placed, in `runChat`. */
export async function handleChat(input: ChatInput): Promise<Response> {
  try {
    return await runChat(input);
  } catch (error) {
    console.error("[chat] the request failed", error);
    return problem(500, "CHAT_FAILED", "The message could not be sent just now. Nothing was charged. Try again.");
  }
}

async function runChat(input: ChatInput): Promise<Response> {
  const parsed = chatBody.safeParse(input.body);
  if (!parsed.success) return problem(400, "INVALID_REQUEST", "The chat request was not valid.");
  if (parsed.data.messages.length > MAX_MESSAGES) return problem(400, "CHAT_TOO_LONG", CHAT_TOO_LONG_MESSAGE);
  const { chainId } = parsed.data;
  // A tab opened before Iter became Rate still sends the old id and tool names.
  const protocol = currentProtocolId(parsed.data.protocol);

  const chain = appChains.find((c) => c.id === chainId);
  const client = await clientFor(chainId);
  if (!chain || !client) return problem(400, "UNSUPPORTED_CHAIN", "That network is not served here.");

  // Every protocol this deployment can use. The request's `protocol` field narrows it (spec D12).
  const adapters = (input.adapters ?? (await protocolSource.adapters())).filter((a) => (protocol === "auto" || a.id === protocol) && a.chains.some((c) => c.id === chainId));
  if (protocol !== "auto" && adapters.length === 0) return problem(400, "UNKNOWN_PROTOCOL", "That protocol is not available on this network.");

  // Built before the messages are checked, so tool parts in the history are held to these tools' own schemas
  // here, with a 400 and no hold, rather than later, mid-stream.
  const instructions = systemPrompt({ brand: BRAND, chainName: chain.name, chainId, account: input.address, nativeSymbol: chain.nativeCurrency.symbol, protocols: adapters.map((a) => ({ id: a.id, name: a.id.charAt(0).toUpperCase() + a.id.slice(1) })) });
  const ctx = { chainId, account: input.address, client };
  const tools = buildTools({ adapters, ctx });

  const validated = await safeValidateUIMessages({ messages: closeInterruptedToolParts(renameLegacyToolParts(parsed.data.messages)), tools: tools as never });
  if (!validated.success) return problem(400, "INVALID_MESSAGES", "The chat messages were not valid.");
  const messages = validated.data;

  const model = input.model ?? (await resolveModel(parsed.data.model).then((info) => (info ? { language: languageModelFor(info.id), info } : null)).catch(() => null));
  // Never a silent substitute: a different model is a different price.
  if (!model) return problem(400, "MODEL_UNAVAILABLE", "That model is not available right now. Choose another.");

  // An existing chat must be the caller's; a new one is created for them.
  const chatId = parsed.data.chatId;
  if (chatId) {
    if (!(await getChat(input.db, { address: input.address, chatId }))) return problem(404, "CHAT_NOT_FOUND", "That chat does not exist.");
  }

  // The model is sent the newest turns that fit its window; the transcript keeps them all. `reserved` is what
  // every prompt carries besides the conversation (instructions, tools) plus the reply it may write, so the
  // estimate for the conversation itself counts only the messages.
  const outsideConversation = estimatePromptTokens({ instructions, tools, messages: [] }) + MAX_OUTPUT_TOKENS;
  const { messages: modelMessages, dropped: trimmed } = trimHistory({ messages, maxTokens: contextBudget(model.info.contextWindow, outsideConversation), estimate: (kept) => estimatePromptTokens({ instructions: "", tools: {}, messages: kept }) });
  const promptTokens = estimatePromptTokens({ instructions, tools, messages: modelMessages });
  const oneStep = holdMicrousd(model.info.price, { estimatedInputTokens: promptTokens, maxOutputTokens: MAX_OUTPUT_TOKENS, maxSteps: 1, marginBps: MARGIN_BPS, minimum: MIN_HOLD });
  await releaseStaleHolds(input.db, new Date(Date.now() - STALE_HOLD_MS), input.address);
  await refillFreeCredit(input.db, input.address);
  let hold = oneStep * BigInt(HOLD_STEPS);
  let reserved = await placeHold(input.db, input.address, hold);
  // Less credit than the usual hold, but enough for one worst-case call: hold all of it. The budget ends the loop when it runs short.
  if (!reserved.ok && reserved.reason !== "blocked" && reserved.spendable >= oneStep) {
    hold = reserved.spendable;
    reserved = await placeHold(input.db, input.address, hold);
  }
  if (!reserved.ok) {
    return problem(402, reserved.reason === "blocked" ? "ACCOUNT_BLOCKED" : "INSUFFICIENT_CREDIT", reserved.reason === "blocked" ? "This account is blocked until its balance is settled." : "There is not enough credit to send this message. It was not sent to the model.", {
      spendableMicrousd: reserved.spendable.toString(),
      neededMicrousd: oneStep.toString(),
      rails: enabledRails(),
    });
  }
  const holdId = reserved.holdId;
  /**
   * Whether this turn may read the person's request at all. Nothing outside is asked anything before the hold,
   * and a turn whose hold had to be cut to what the account could spare gets no reader either: under R9 a
   * pre-run turn is charged for the call it gives up on AND the real one, and that hold covers only one call.
   */
  const read = hold < oneStep * BigInt(HOLD_STEPS) ? null : (input.read === undefined ? readerFromEnv() : input.read);
  // From here on credit is held. Whatever throws, it is given back before the error leaves (settling twice is harmless).
  try {
    return await streamReply({ input, messages, modelMessages, trimmed, model, hold, holdId, chatId, folderId: parsed.data.folderId, protocol, chainId, instructions, tools, adapters, ctx, read, promptTokens, sendFloor: oneStep });
  } catch (error) {
    await settleHold(input.db, { holdId, cost: 0n, ref: `usage:${holdId}` });
    throw error;
  }
}

async function streamReply(args: { input: ChatInput; /** The whole chat: what is saved. */ messages: UIMessage[]; /** Its newest part: what the model and the reader are sent. */ modelMessages: UIMessage[]; trimmed: number; model: { language: LanguageModel; info: AvailableModel }; hold: bigint; holdId: string; chatId: string | undefined; folderId: string | undefined; protocol: string; chainId: number; instructions: string; tools: ReturnType<typeof buildTools>; adapters: readonly ProtocolAdapter[]; ctx: AdapterContext; read: RequestReader | null; promptTokens: number; /** What one send like this needs held: the refusal's `neededMicrousd`. */ sendFloor: bigint }): Promise<Response> {
  const { input, messages, modelMessages, trimmed, model, hold, holdId, protocol, chainId, instructions, tools, adapters, ctx, read, promptTokens, sendFloor } = args;
  const earlier = earlierTurns(messages.at(-1));
  const finalChatId = args.chatId ?? (await createChat(input.db, { address: input.address, title: titleFrom(messages), model: model.info.id, protocol, chainId, folderId: args.folderId })).id;
  // The model, protocol and network belong to the chat (spec D12): what this message was sent with is what it reopens with.
  if (args.chatId) await updateChat(input.db, { address: input.address, chatId: args.chatId, model: model.info.id, protocol, chainId });

  const budget = createBudget({ holdMicrousd: hold, price: model.info.price, marginBps: MARGIN_BPS, maxOutputTokens: MAX_OUTPUT_TOKENS });
  const agent = createTradingAgent({ model: model.language, instructions, tools, budget });

  // The budget stops the loop BEFORE a step that might not fit. This is the backstop for the one case it cannot
  // see coming: a first prompt that tokenizes far above its estimate. Nothing further is started after it.
  const guard = new AbortController();
  const signal = input.signal ? AbortSignal.any([input.signal, guard.signal]) : guard.signal;
  /** What Jev cost, whenever it answered at all — a reading that was dropped is still a reading that was paid for (spec R6). */
  let routerUsage: RequestReading["usage"] | null = null;
  /** How the call this turn gave up on was counted (spec R9). Only ever set when a reading was obtained. */
  let speculative: { inputTokens: number; estimated: boolean } | null = null;
  let settled = false;
  const settle = async () => {
    if (settled) return;
    settled = true;
    const cost = budget.spent;
    if (cost > hold) console.warn(`[billing] a chat turn cost ${cost} micro-USD against a hold of ${hold}; the difference is not charged`, { model: model.info.id, chatId: finalChatId });
    // What the reader itself cost is recorded, never charged: the price of a message is the chat model's alone.
    const router = routerUsage && { ...routerUsage, ...(speculative ? { speculative } : {}) };
    await settleHold(input.db, { holdId, cost, ref: `usage:${holdId}`, meta: { model: model.info.id, chatId: finalChatId, ...(router ? { router } : {}) } });
  };

  // Both paths end the same way, so neither can drift from the other: one settlement, one save, one budget.
  const headers = { "x-chat-id": finalChatId, "cache-control": "no-store" };
  const charge = (usage: BilledUsage) => {
    budget.add(usage);
    if (budget.spent >= hold) guard.abort();
  };
  /** The last model call's input as the provider counted it: what the context bar shows, tool results and all. */
  let measuredInput: number | null = null;
  const measure = (usage: BilledUsage) => {
    if (isTokenCount(usage.inputTokens) && usage.inputTokens > 0) measuredInput = usage.inputTokens;
  };
  const onStepEnd = ({ usage }: { usage: unknown }) => (measure(usage as BilledUsage), charge(usage as BilledUsage));
  const messageMetadata = ({ part }: { part: { type: string } }): ChatMetadata | undefined => {
    // `trimmed` is sent even when it is 0: a continued reply takes its start metadata over the old, and must not keep a stale count.
    if (part.type === "start") return { model: model.info.id, chatId: finalChatId, trimmed };
    // `abort` is how a stopped reply ends: it was still charged for what ran, so it still says what it cost.
    // Every key is sent, `stoppedForBudget` included: a continued reply's metadata is merged over the old, so a key
    // left out would keep the earlier turn's value.
    if (part.type === "finish" || part.type === "abort") {
      const used = budget.usage();
      return {
        costMicrousd: (earlier.costMicrousd + (budget.spent > hold ? hold : budget.spent)).toString(),
        usage: { inputTokens: earlier.usage.inputTokens + used.inputTokens, outputTokens: earlier.usage.outputTokens + used.outputTokens, cacheReadTokens: earlier.usage.cacheReadTokens + used.cacheReadTokens },
        contextTokens: measuredInput ?? promptTokens,
        contextWindow: model.info.contextWindow,
        stoppedForBudget: budget.stopped,
        sendFloorMicrousd: sendFloor.toString(),
      };
    }
    return undefined;
  };
  /** Runs when the stream ends, aborts, is cancelled by the browser, or fails: `ai` calls it from both `flush` and `cancel`. */
  const onEnd = async ({ messages: transcript }: { messages: UIMessage[] }) => {
    await settle();
    await saveMessages(input.db, { address: input.address, chatId: finalChatId, messages: transcript.map((m) => ({ id: m.id, role: m.role, parts: m.parts, metadata: m.metadata })) });
  };

  try {
    if (!read) {
      return await createAgentUIStreamResponse({
        agent,
        uiMessages: modelMessages,
        abortSignal: signal,
        // The agent's message type is inferred from a tool set built per request, so it cannot be named here.
        originalMessages: messages as never,
        // The reply's id is made HERE and streamed to the browser, so the saved transcript and the browser's copy agree.
        // Left to default, the saved reply has no id, and the second one saved to a chat collides with the first.
        generateMessageId: generateId,
        onStepEnd,
        messageMetadata,
        onEnd: onEnd as never,
        onError: modelErrorSentence,
        headers,
      });
    }

    /**
     * With a reader, the model call and the reading start TOGETHER (spec R8).
     *
     * The model's stream is pumped here rather than merged, so this turn can see what the model has said. Its
     * opening chunks carry no words, so they are held back; the first chunk that is not one of them COMMITS the
     * turn to the ordinary path, and from then on Jev cannot change it. If a confident reading gets there first,
     * the model call is given up on, the rank read runs, and the model is started again with the result in hand —
     * all on ONE assistant message, whose id is made here and given to every part of the turn.
     */
    const messageId = generateId();
    // Once the turn has committed, nothing is waiting for a reading: the reader is told to stop rather than left running.
    const readerGuard = new AbortController();
    const stream = createUIMessageStream({
      // NOT including any pre-run message, or the saved transcript would hold its part twice.
      originalMessages: messages as never,
      onError: modelErrorSentence,
      onEnd: onEnd as never,
      execute: async ({ writer }) => {
        const speculation = new AbortController();
        const turn = { committed: false, switched: false };
        /**
         * R9: the call a switched turn gives up on is charged, not absorbed — a provider may bill a request it
         * never answered — and charged ONCE, by whichever call measures it first (speculation.ts). Both callbacks
         * are made here, from one rule, so no `await` added to the pump can make them both fire.
         */
        const charges = stepCharges({ turn, charge, record: (record) => { speculative = record; } });
        // A call given up on does not say what the reply was sent: only the one that goes on is measured.
        const speculativeStepEnd = ({ usage }: { usage: unknown }) => (turn.switched || measure(usage as BilledUsage), charges.speculative(usage as BilledUsage));
        const restartedStepEnd = ({ usage }: { usage: unknown }) => (measure(usage as BilledUsage), charges.restarted(usage as BilledUsage));
        // `onError` belongs on the agent's own stream: a model failure surfaces as an error part INSIDE it, and
        // without this the person would be shown the library's default sentence instead of ours.
        const speculativeStream = await createAgentUIStream({
          agent,
          uiMessages: modelMessages as never,
          abortSignal: AbortSignal.any([signal, speculation.signal]),
          generateMessageId: () => messageId,
          onStepEnd: speculativeStepEnd,
          messageMetadata,
          onError: modelErrorSentence,
        });

        const reader = (speculativeStream as ReadableStream<{ type: string }>).getReader();
        let reachedCommit!: () => void;
        const committed = new Promise<null>((resolve) => (reachedCommit = () => resolve(null)));
        const pump = pumpSpeculative({ reader, write: (chunk) => writer.write(chunk as never), turn, onCommit: reachedCommit });

        const asked = readRequestFor({ messages: modelMessages, adapters, read, signal: AbortSignal.any([signal, readerGuard.signal]) }).then((found) => {
          // Recorded the moment it arrives, whether or not this turn goes on to use it (spec R6).
          routerUsage = found?.usage ?? null;
          return found;
        });
        const reading = await Promise.race([committed, asked]);
        if (!reading || !reading.measure || turn.committed) {
          // A reading cancelled here is deliberately NOT recorded in `meta.router`: none was obtained, so there
          // is nothing Jev charged for. Only a reading that actually arrived sets `routerUsage`, above.
          readerGuard.abort();
          await pump;
          return;
        }
        readerGuard.abort(); // the reading is in hand; nothing more is expected of the reader

        // The rank read runs while the speculative call keeps going, so nothing is given up for a read that may
        // fail. If it fails, or the model finds its own words while it runs, the ordinary turn simply carries on.
        // It is raced against the commit rather than awaited: a turn that has committed is waiting for nothing,
        // and must not hold the reply — and so the `finish` chunk's cost and the settlement — open for a read
        // whose answer it can no longer use. The read is a GET; the orphaned one is let go of, never unowned.
        const ranking = runPrerun({ adapters, ctx, measure: reading.measure, messageId }).catch(() => null);
        const prerun = await Promise.race([ranking, committed]);
        // Nothing may be awaited between here and the switch, or the pump could commit underneath it.
        if (!prerun || turn.committed) {
          await pump;
          return;
        }
        turn.switched = true;
        speculation.abort();
        void reader.cancel().catch(() => {});
        void pump.catch(() => {}); // it writes nothing now, but no promise in this turn is left unowned

        // The same metadata the ordinary path opens with, plus what the reader made of the message.
        writer.write({ type: "start", messageId, messageMetadata: { ...messageMetadata({ part: { type: "start" } }), router: reading.router } satisfies ChatMetadata } as never);
        writer.write({ type: "start-step" } as never);
        writer.write({ type: "tool-input-available", toolCallId: prerun.toolCallId, toolName: prerun.toolName, input: prerun.input } as never);
        writer.write({ type: "tool-output-available", toolCallId: prerun.toolCallId, output: prerun.output } as never);
        writer.write({ type: "finish-step" } as never);
        writer.merge((await createAgentUIStream({ agent, uiMessages: [...modelMessages, prerun.message] as never, abortSignal: signal, sendStart: false, onStepEnd: restartedStepEnd, messageMetadata, onError: modelErrorSentence })) as never);
      },
    });
    return createUIMessageStreamResponse({ stream, headers });
  } catch (error) {
    await settle();
    throw error;
  }
}

/**
 * What the person is told when the model fails mid-stream. The gateway's own message never reaches the browser
 * (it can carry internals); a refusal the person can act on is named, everything else gets one plain sentence.
 */
export function modelErrorSentence(error: unknown): string {
  const text = error instanceof Error ? `${error.message} ${String((error as { cause?: unknown }).cause ?? "")}` : String(error);
  if (/free tier users do not have access/i.test(text)) return "This model needs paid AI gateway credits. Choose another model, or add credits to the gateway.";
  return "The model could not answer just now. Your message is kept; try again.";
}
