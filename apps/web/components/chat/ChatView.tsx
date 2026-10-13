"use client";

import { useChat } from "@ai-sdk/react";
import { useQueryClient } from "@tanstack/react-query";
import { DefaultChatTransport, getToolName, isToolUIPart, type UIMessage } from "ai";
import { useRouter } from "next/navigation";
import { Fragment, useEffect, useState } from "react";
import type { PublicClient } from "viem";
import { usePublicClient } from "wagmi";
import { formatUsd } from "@repo/agent/pricing";
import { clientToolNames } from "@repo/agent/tools";
import { createRateAdapter } from "@repo/protocols/rate";
import { browserGatewayFetch } from "@/lib/protocols/browserGateway";
import { createProxiedMcpAdapter } from "@repo/protocols/mcp";
import { VERIFIED_MANIFESTS } from "@repo/protocols/verified";
import type { ProtocolAdapter } from "@repo/protocols/types";
import { BRAND_DESCRIPTION } from "@repo/ui/brand";
import { useWalletAccount, useWalletConnect } from "@repo/wallet";
import { Conversation, ConversationContent, ConversationScrollButton } from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { appChains } from "@/lib/chains";
import { attachActionRuns, detachActionRuns, startActionRun, useActiveActionRuns } from "@/lib/chat/actionRuns";
import { createAutoContinue } from "@/lib/chat/autoContinue";
import { CHAT_TOO_LONG_MESSAGE } from "@/lib/chat/tooLong";
import { chatUsage, latestSendFloor, replyCosts, replyLine, trimmedCount, type UsageMetadata } from "@/lib/chat/usage";
import { savedSelection as safeSelection, useChatOptions, useChatSelection, type ChatSelection } from "@/lib/chat/useChatOptions";
import { useAppSession } from "@/lib/session/useAppSession";
import { PendingDots, StreamingCursor, ThinkingStatus } from "./motion";
import { PromptInput } from "./PromptInput";
import { CreditChip } from "./CreditChip";
import { ActionToolPart, ReadToolPart, TopUpCard, type ToolPartLike } from "./ToolParts";
import { UsageChip } from "./UsageChip";

/** Every protocol this build trusts, for turning a tool name back into the action to run. A Verified protocol's builds go through our server. */
const ADAPTERS: readonly ProtocolAdapter[] = [createRateAdapter({ fetch: browserGatewayFetch }), ...VERIFIED_MANIFESTS.map((manifest) => createProxiedMcpAdapter({ manifest, chains: appChains }))];
/** Which tools the BROWSER answers, from the same function the server builds its tool list with, so the two cannot drift. */
const CLIENT_TOOLS = clientToolNames(ADAPTERS);
const APP_TOOLS = new Set(CLIENT_TOOLS.app);
/** Tools that END a turn by taking the person to another screen. The model is not waiting on them, so they never trigger a follow-up request. */
const NAVIGATION_TOOLS = new Set(["openDeposit", "openWithdraw"]);
/** Browser tools whose answer the model needs in order to go on: every action, and the wallet's status. */
const modelAwaits = (name: string) => (APP_TOOLS.has(name) && !NAVIGATION_TOOLS.has(name)) || name in CLIENT_TOOLS.actions;

interface Metadata extends UsageMetadata {
  model?: string;
  costMicrousd?: string;
  chatId?: string;
  stoppedForBudget?: boolean;
}
type ChatMessage = UIMessage<Metadata>;

/** A non-2xx answer from /api/chat, with its machine-readable body kept. */
class ChatHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: { error?: { code?: string; message?: string }; spendableMicrousd?: string; rails?: string[] },
  ) {
    // A platform in front of the server can refuse an oversized body with a bare 413 before this route sees it.
    super(body.error?.message ?? (status === 413 ? CHAT_TOO_LONG_MESSAGE : "The chat request failed."));
  }
}

function findAction(toolName: string) {
  const named = CLIENT_TOOLS.actions[toolName];
  return named ? (ADAPTERS.find((adapter) => adapter.id === named.protocol)?.actions[named.action] ?? null) : null;
}

interface LiveBox {
  chatId: string | null;
  /** The folder a NEW chat is filed into when it starts. Ignored once the chat exists. */
  folderId: string | null;
  selection: { model: string; protocol: string; chainId: number };
  address: `0x${string}` | undefined;
  client: ReturnType<typeof usePublicClient>;
  chain: (typeof appChains)[number];
}

function createTransport(live: LiveBox) {
  return new DefaultChatTransport<ChatMessage>({
    api: "/api/chat",
    body: () => ({ chatId: live.chatId ?? undefined, folderId: live.chatId ? undefined : (live.folderId ?? undefined), model: live.selection.model, protocol: live.selection.protocol, chainId: live.selection.chainId }),
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      if (!response.ok) throw new ChatHttpError(response.status, (await response.json().catch(() => ({}))) as ChatHttpError["body"]);
      const id = response.headers.get("x-chat-id");
      if (id && !live.chatId) {
        live.chatId = id;
        // The chat now exists on the server: give it its own address without a navigation that would drop the stream.
        window.history.replaceState(null, "", `/c/${id}`);
      }
      return response;
    },
  });
}

const SUGGESTIONS = ["Show available markets", "What are my balances?", "Show my open orders", "Quote 10 USDC to ETH"];
const PREVIEW_RESPONSES = [
  "Preview loaded: I can scan supported markets and surface a route once you connect a wallet.",
  "Preview loaded: live balances stay private to your wallet. Connect when you want me to read them.",
  "Preview loaded: open orders and positions will appear here after wallet access is approved.",
  "Preview route: USDC → EURC on Rate, with spend limits and wallet approval shown before anything is signed.",
];

function previewReply(prompt: string) {
  const normalized = prompt.toLowerCase();
  const index = normalized.includes("market") ? 0 : normalized.includes("balance") ? 1 : normalized.includes("order") ? 2 : normalized.includes("quote") || normalized.includes("swap") ? 3 : 0;
  return PREVIEW_RESPONSES[index];
}

export function ChatView({ chatId, initialMessages, savedSelection, folderId = null }: { chatId: string | null; initialMessages: ChatMessage[]; /** A saved chat's own model, protocol and network. */ savedSelection?: ChatSelection; /** For a new chat: the folder it is filed into. */ folderId?: string | null }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [selection, select] = useChatSelection(savedSelection ? safeSelection(savedSelection) : undefined);
  const options = useChatOptions();
  const session = useAppSession();
  const { address, isConnected } = useWalletAccount();
  const { open: connectWallet, ready } = useWalletConnect();
  const [previewMessages, setPreviewMessages] = useState<Array<{ role: "user" | "assistant"; text: string }>>([]);
  const client = usePublicClient({ chainId: selection.chainId });
  const chain = appChains.find((c) => c.id === selection.chainId) ?? appChains[0];

  // What a request is sent with is read when it is SENT, never while rendering: the pills the person sees at
  // that moment are what goes. A plain mutable box, kept for the life of this view and refreshed after each render.
  const [live] = useState<LiveBox>(() => ({ chatId, folderId, selection, address, client, chain }));
  useEffect(() => {
    Object.assign(live, { selection, address, client, chain });
  });
  const [transport] = useState(() => createTransport(live));
  const [auto] = useState(() => createAutoContinue(modelAwaits));

  // This view owns the actions it starts. When it goes, they stop reporting: a report is a new, billed request.
  const [owner] = useState(() => ({}));
  useEffect(() => {
    attachActionRuns(owner);
    return () => detachActionRuns(owner);
  }, [owner]);
  const activeRuns = useActiveActionRuns(owner);
  // Messages that were already there when the view opened are shown as they are; only new ones rise in.
  const [initialIds] = useState(() => new Set(initialMessages.map((m) => m.id)));

  const chat = useChat<ChatMessage>({
    id: chatId ?? "new",
    messages: initialMessages,
    transport,
    // After the browser answers a tool call (an action's result), the model continues by itself. Only then, and not forever.
    sendAutomaticallyWhen: auto.shouldContinue,
    onFinish: () => {
      void queryClient.invalidateQueries({ queryKey: ["chats"] });
      void session.refresh();
    },
    onToolCall: ({ toolCall }) => {
      if (toolCall.dynamic) return;
      const name = toolCall.toolName as string;
      const reply = (output: unknown) => void chat.addToolOutput({ tool: name as never, toolCallId: toolCall.toolCallId, output: output as never });
      const now = live;

      if (name === "getWalletStatus") return reply({ connected: Boolean(now.address), address: now.address ?? null, chainId: now.selection.chainId });
      if (NAVIGATION_TOOLS.has(name)) {
        // Answered first, so the saved transcript is complete; then the person is taken there. Nothing is sent to the model.
        reply({ opened: true });
        router.push(name === "openDeposit" ? "/deposit" : "/withdraw");
        return;
      }

      const action = findAction(name);
      if (!action) return; // a server tool: its result arrives in the stream
      if (!now.address || !now.client) return reply({ status: "failed", hashes: [], code: "WALLET", message: "No wallet is connected, so nothing was sent." });
      startActionRun({ toolCallId: toolCall.toolCallId, owner, action, intent: toolCall.input, account: now.address, chainId: now.selection.chainId, client: now.client as PublicClient, gasSymbol: now.chain.nativeCurrency.symbol, report: reply });
    },
  });

  const busy = chat.status === "submitted" || chat.status === "streaming";
  const httpError = chat.error instanceof ChatHttpError ? chat.error : null;
  const outOfCredit = httpError?.status === 402;
  const usage = chatUsage(chat.messages);
  const trimmed = trimmedCount(chat.messages);

  const disabledReason = session.isSigningIn ? "Signing you in…" : isConnected && !session.signedIn ? (session.error ? "Sign in to continue." : "Signing you in…") : options.isLoading ? "Loading models…" : options.isError || (options.data && !options.data.models.some((m) => m.available)) ? "No model can be reached right now. Try again in a minute." : activeRuns > 0 ? "Finish or cancel the action above first." : null;


  /** What the person sends, typed or picked from a card. */
  const send = (text: string) => {
    // Without a wallet nothing reaches the model, so the auto-continue budget is not touched either.
    if (!isConnected) {
      setPreviewMessages((messages) => [...messages, { role: "user", text }, { role: "assistant", text: previewReply(text) }]);
      return;
    }
    auto.personSpoke();
    chat.clearError();
    void chat.sendMessage({ text });
  };
  return (
    <div className="relative isolate flex min-h-0 flex-1 flex-col">
      <div aria-hidden data-testid="chat-sky" className="chat-sky" data-quiet={chat.messages.length > 0 || previewMessages.length > 0 ? "" : undefined} />
      <Conversation className="min-h-0 flex-1">
        <ConversationContent className="mx-auto w-full max-w-[760px] gap-5 px-4 py-6">
          {chat.messages.length === 0 && (
            <div className="flex flex-col items-start gap-4 pb-4 pt-3 sm:gap-5 sm:pb-8 sm:pt-[12vh]">
              {/* The shell logo already identifies eziee and its DeFi desk context. */}
              <h1 className="on-sky-text text-[clamp(2.5rem,5vw,4rem)] font-bold leading-[1.04] tracking-[-0.05em]">
                Your intent.<br /><span className="text-[color:var(--m-primary-fg)]">Into action.</span>
              </h1>
              <p className="on-sky-text max-w-[470px] text-[15px] font-medium leading-relaxed text-[color:var(--m-text-primary)] dark:text-[color:var(--m-text-secondary)]">{BRAND_DESCRIPTION}</p>
              {!isConnected && (
                <button type="button" data-testid="chat-connect" disabled={!ready} onClick={connectWallet} className="min-h-12 self-start rounded-xl bg-[color:var(--m-primary)] px-5 text-[15px] font-semibold text-[color:var(--m-on-primary)] hover:bg-[color:var(--m-primary-hover)] disabled:opacity-60">
                  Continue with a passkey
                </button>
              )}
            </div>
          )}

          {previewMessages.map((message, index) => <Message key={`preview-${index}`} from={message.role} data-testid={`preview-message-${message.role}`}><MessageContent className="gap-3"><MessageResponse>{message.text}</MessageResponse></MessageContent></Message>)}

          {chat.messages.map((message, position) => {
            // The cursor follows the last text of the reply that is streaming, and only while it is.
            const streaming = chat.status === "streaming" && message.role === "assistant" && position === chat.messages.length - 1;
            const cursorAfter = streaming ? message.parts.findLastIndex((part) => part.type === "text") : -1;
            return (
            <Fragment key={message.id}>
            {position === trimmed && trimmed > 0 && (
              <p data-testid="trim-divider" className="flex items-center gap-3 text-xs text-[color:var(--m-text-secondary)] before:h-px before:flex-1 before:bg-[color:var(--m-border)] after:h-px after:flex-1 after:bg-[color:var(--m-border)]">
                Earlier messages are kept but no longer sent to the model
              </p>
            )}
            <Message from={message.role} data-testid={`message-${message.role}`} className={message.role === "assistant" && !initialIds.has(message.id) ? "rise-in" : undefined}>
              <MessageContent className="gap-3">
                {message.parts.map((part, index) => {
                  if (part.type === "text") return <Fragment key={index}><MessageResponse>{part.text}</MessageResponse>{index === cursorAfter && <StreamingCursor />}</Fragment>;
                  if (!isToolUIPart(part)) return null;
                  const name = getToolName(part) as string;
                  if (APP_TOOLS.has(name)) return null;
                  const like = part as unknown as ToolPartLike;
                  // Keyed by the call, so the part rises in once as it appears, not again when its card turns into the result. History stays still.
                  return (
                    <div key={like.toolCallId} data-testid="tool-part" className={initialIds.has(message.id) ? undefined : "rise-in"}>
                      {findAction(name) ? <ActionToolPart part={like} toolName={name} fallbackChainId={selection.chainId} /> : <ReadToolPart part={like} toolName={name} onAsk={busy || disabledReason !== null ? undefined : send} />}
                    </div>
                  );
                })}
                {message.role === "assistant" && message.metadata?.stoppedForBudget && (
                  <p data-testid="message-budget-stop" className="text-[13px] text-[color:var(--m-text-secondary)]">
                    Stopped here to stay inside the credit held for this message. Ask again to continue.
                  </p>
                )}
                {message.role === "assistant" && message.metadata?.costMicrousd && (
                  <span data-testid="message-cost" className="font-dm-mono text-xs text-[color:var(--m-text-secondary)]">
                    {replyLine({ ...message.metadata, costMicrousd: message.metadata.costMicrousd })}
                  </span>
                )}
              </MessageContent>
            </Message>
            </Fragment>
            );
          })}

          <ThinkingStatus thinking={chat.status === "submitted"} />
          {chat.status === "submitted" && <PendingDots />}

          {outOfCredit && <TopUpCard spendable={formatUsd(BigInt(httpError.body.spendableMicrousd ?? "0"))} rails={httpError.body.rails ?? []} />}
          {chat.error && !outOfCredit && (
            <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[color:var(--m-border)] bg-[color:var(--m-surface)] p-4 text-sm">
              <span>{httpError?.body.error?.message ?? (chat.error instanceof TypeError || !chat.error.message ? "The reply was interrupted. Your messages are kept." : chat.error.message)}</span>
              <button type="button" onClick={() => (chat.clearError(), void chat.regenerate())} className="min-h-11 rounded-xl border border-[color:var(--m-border)] px-4 font-semibold hover:bg-[color:var(--m-surface-2)]">
                Try again
              </button>
            </div>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="mx-auto w-full max-w-[760px] px-4 pb-5 pt-2">
        {isConnected && !session.signedIn && session.error && (
          <div role="alert" className="mb-2 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[color:var(--m-border)] bg-[color:var(--m-surface)] p-3 text-sm">
            <span>{session.error}</span>
            <button type="button" data-testid="sign-in-retry" onClick={() => void session.retry()} className="min-h-11 rounded-xl border border-[color:var(--m-border)] px-4 font-semibold hover:bg-[color:var(--m-surface-2)]">
              Sign in again
            </button>
          </div>
        )}
        <PromptInput
          selection={selection}
          onSelect={select}
          models={options.data?.models ?? []}
          protocols={options.data?.protocols ?? []}
          busy={busy}
          disabledReason={disabledReason}
          onSend={send}
          onStop={() => void chat.stop()}
          chips={
            <>
              {usage.replies > 0 && <UsageChip usage={usage} trimmed={trimmed} />}
              <CreditChip replyCosts={replyCosts(chat.messages)} sendFloorMicrousd={latestSendFloor(chat.messages)} />
            </>
          }
          suggestions={chat.messages.length === 0 ? SUGGESTIONS : []}
        />
      </div>
      {!isConnected && <p className="mx-auto w-full max-w-[760px] px-4 pb-4 text-center text-xs text-[color:var(--m-text-secondary)]">Preview mode · connect a wallet when you want live balances, quotes, and approvals.</p>}
    </div>
  );
}
