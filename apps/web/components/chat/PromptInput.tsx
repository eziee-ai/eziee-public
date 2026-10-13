"use client";

import { ArrowUp, ChevronDown, Cpu, Plug, Square } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@repo/ui/cn";
import { appChains } from "@/lib/chains";
import { radioKeys, rovingTabIndex } from "@/lib/radioKeys";
import type { ChatSelection, ModelOption, ProtocolOption } from "@/lib/chat/useChatOptions";

/**
 * The prompt input (spec D12, §7.4): the message, and two pills beside Send.
 * The PROTOCOL pill sets the network and which protocols' tools the model is
 * given; "Auto" offers every protocol on that network. The MODEL pill lists the
 * allowlisted models the gateway serves right now.
 */

const PILL = "flex h-9 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-[13px] font-medium text-[color:var(--m-text-secondary)] transition-colors hover:bg-[color:var(--m-surface-2)] hover:text-[color:var(--m-text-primary)] disabled:cursor-not-allowed disabled:opacity-55";
const PILL_OPEN = "bg-[color:var(--m-surface-2)] text-[color:var(--m-text-primary)]";
const OPTION = "flex min-h-[52px] w-full items-center gap-3 rounded-xl border border-transparent px-3 py-2 text-left text-sm transition-colors hover:bg-[color:var(--m-surface-2)]";
const OPTION_ON = "border-[color:var(--m-primary-fg)] bg-[color:var(--m-surface-selected)] text-[color:var(--m-on-surface-selected)]";

function Dot({ on }: { on: boolean }) {
  return <span aria-hidden className={cn("grid h-4 w-4 shrink-0 place-items-center rounded-full border-[1.5px] border-[color:var(--m-text-secondary)]", on && "border-[color:var(--m-primary-fg)] after:h-2 after:w-2 after:rounded-full after:bg-[color:var(--m-primary-fg)] after:content-['']")} />;
}

/** A pill that opens a panel above it. Closes on Escape, on a click outside, and hands focus back to the pill. */
function PillMenu({ label, icon, title, testId, disabled, children }: { label: string; icon: ReactNode; title: string; testId: string; disabled: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  const close = () => {
    setOpen(false);
    button.current?.focus();
  };

  // Opening moves focus to the current choice, so the keyboard starts where the eye does.
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) (panel.current?.querySelector<HTMLElement>('[role="radio"][tabindex="0"]') ?? panel.current?.querySelector<HTMLElement>('[role="radio"]'))?.focus();
  }, [open]);

  return (
    <div
      ref={root}
      className="relative"
      onKeyDown={(event: KeyboardEvent) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          close();
        }
      }}
    >
      <button ref={button} type="button" data-testid={testId} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined} disabled={disabled} onClick={() => setOpen((v) => !v)} className={cn(PILL, open && PILL_OPEN)}>
        {icon}
        <span>{label}</span>
        <ChevronDown aria-hidden className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div
          ref={panel}
          id={panelId}
          role="dialog"
          aria-label={title}
          // A choice that settles the menu carries `data-close-menu`; the network switch does not, so it stays open.
          onClick={(event) => {
            if ((event.target as HTMLElement).closest("[data-close-menu]")) close();
          }}
          className="absolute bottom-[calc(100%+8px)] left-0 z-20 flex w-[min(440px,calc(100vw-2rem))] flex-col gap-1.5 rounded-2xl border border-[color:var(--m-border)] bg-[color:var(--m-surface)] p-3 shadow-xl"
        >
          {children}
        </div>
      )}
    </div>
  );
}

export interface PromptInputProps {
  selection: ChatSelection;
  onSelect: (patch: Partial<ChatSelection>) => void;
  models: ModelOption[];
  protocols: ProtocolOption[];
  busy: boolean;
  /** Names the unmet condition beside the control (design guide: disabled states say why). */
  disabledReason: string | null;
  onSend: (text: string) => void;
  onStop: () => void;
  suggestions?: string[];
  /** Small read-outs shown in the pill row, such as what the chat has used. */
  chips?: ReactNode;
}

export function PromptInput({ selection, onSelect, models, protocols, busy, disabledReason, onSend, onStop, suggestions = [], chips }: PromptInputProps) {
  const [text, setText] = useState("");
  const disabled = disabledReason !== null;
  const chain = appChains.find((c) => c.id === selection.chainId) ?? appChains[0];
  const onChain = protocols.filter((p) => p.chains.includes(chain.id));
  const protocol = selection.protocol === "auto" ? null : (onChain.find((p) => p.id === selection.protocol) ?? null);
  const model = models.find((m) => m.id === selection.model);

  const submit = () => {
    const value = text.trim();
    if (!value || disabled || busy) return;
    onSend(value);
    setText("");
  };

  return (
    <div className="flex flex-col gap-2.5">
      {suggestions.length > 0 && (
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
          {suggestions.map((s) => (
            <button key={s} type="button" disabled={disabled || busy} onClick={() => onSend(s)} className="on-sky min-h-11 rounded-xl border border-[color:var(--m-border)] px-3 py-2 text-left text-[13px] leading-snug font-medium motion-color hover:bg-[color:var(--m-surface)] disabled:cursor-not-allowed disabled:opacity-55 sm:rounded-full sm:px-4 sm:text-center sm:text-sm">
              {s}
            </button>
          ))}
        </div>
      )}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        className="flex flex-col rounded-[28px] border border-[color:var(--m-border)] bg-[color:var(--m-surface)] px-3 pb-2.5 pt-3 shadow-[0_2px_16px_rgba(0,0,0,0.06)] transition-[border-color,box-shadow] focus-within:border-[color:var(--m-border-strong)] focus-within:shadow-[0_4px_24px_rgba(0,0,0,0.10)]"
      >
        <label htmlFor="chat-message" className="sr-only">
          Message
        </label>
        <textarea
          id="chat-message"
          data-testid="chat-input"
          rows={1}
          value={text}
          disabled={disabled}
          placeholder="Describe your next move"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends; Shift+Enter is a new line. Never while an IME is composing.
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
          className="max-h-52 min-h-12 w-full resize-none bg-transparent px-2 pb-3 pt-1 text-base leading-6 outline-none [field-sizing:content] placeholder:text-[color:var(--m-text-secondary)] focus-visible:outline-none disabled:cursor-not-allowed"
        />

        {/* The pills and chips wrap among themselves; Send keeps its place at the right, whatever the width. */}
        <div className="flex items-center gap-2">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5">
            <PillMenu testId="protocol-pill" title="Protocol and network" disabled={disabled} icon={<Plug aria-hidden className="h-[15px] w-[15px]" />} label={`${protocol ? protocol.name : "Auto"} · ${chain.name}`}>
              <>
                  <span className="px-1 text-xs font-semibold text-[color:var(--m-text-secondary)]">Network</span>
                  <div role="radiogroup" aria-label="Network" onKeyDown={radioKeys} className="flex rounded-full bg-[color:var(--m-surface-2)] p-1">
                    {appChains.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        role="radio"
                        aria-checked={c.id === chain.id}
                        tabIndex={rovingTabIndex(c.id === chain.id, false, true)}
                        data-testid={`chat-network-${c.id}`}
                        // A protocol that is not on the new network falls back to Auto, never to a silent mismatch.
                        onClick={() => onSelect({ chainId: c.id, protocol: protocols.some((p) => p.id === selection.protocol && p.chains.includes(c.id)) ? selection.protocol : "auto" })}
                        className={cn("min-h-10 flex-1 rounded-full text-[13px] font-semibold", c.id === chain.id && "bg-[color:var(--m-background)] shadow-[0_0_0_1px_var(--m-border)]")}
                      >
                        {c.name}
                      </button>
                    ))}
                  </div>

                  <span className="px-1 pt-2 text-xs font-semibold text-[color:var(--m-text-secondary)]">The agent may use</span>
                  <div role="radiogroup" aria-label="Protocol" onKeyDown={radioKeys} className="flex flex-col gap-1">
                    <button type="button" role="radio" aria-checked={protocol === null} tabIndex={rovingTabIndex(protocol === null, true, true)} data-testid="protocol-auto" data-close-menu onClick={() => onSelect({ protocol: "auto" })} className={cn(OPTION, protocol === null && OPTION_ON)}>
                      <Dot on={protocol === null} />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="font-semibold">Auto</span>
                        <span className="text-xs text-[color:var(--m-text-secondary)]">Any protocol on this network</span>
                      </span>
                    </button>
                    {onChain.map((p) => (
                      <button key={p.id} type="button" role="radio" aria-checked={protocol?.id === p.id} tabIndex={rovingTabIndex(protocol?.id === p.id, false, true)} data-testid={`protocol-${p.id}`} data-close-menu onClick={() => onSelect({ protocol: p.id })} className={cn(OPTION, protocol?.id === p.id && OPTION_ON)}>
                        <Dot on={protocol?.id === p.id} />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="font-semibold">{p.name}</span>
                          <span className="text-xs text-[color:var(--m-text-secondary)]">{p.capabilities.join(", ")}</span>
                        </span>
                        <span className="whitespace-nowrap text-[11px] font-semibold text-[color:var(--m-text-secondary)]">{p.tier === "first-party" ? "First-party" : "Verified"}</span>
                      </button>
                    ))}
                  </div>

                  {!protocols.some((p) => p.tier === "verified") && (
                    <div className="flex flex-col gap-1 rounded-xl border border-dashed border-[color:var(--m-border)] px-3 py-2.5">
                      <span className="text-[13px] font-semibold">Verified over MCP</span>
                      <span className="text-xs text-[color:var(--m-text-secondary)]">None yet. A protocol joins by publishing an MCP server and a reviewed manifest.</span>
                    </div>
                  )}
              </>
            </PillMenu>

            <PillMenu testId="model-pill" title="Model" disabled={disabled} icon={<Cpu aria-hidden className="h-[15px] w-[15px]" />} label={model?.label ?? "Choose a model"}>
              <>
                  <div role="radiogroup" aria-label="Model" onKeyDown={radioKeys} className="flex flex-col gap-1">
                    {models.map((m, index) => (
                      <button key={m.id} type="button" role="radio" aria-checked={m.id === selection.model} tabIndex={rovingTabIndex(m.id === selection.model, index === models.findIndex((o) => o.available), models.some((o) => o.id === selection.model && o.available))} aria-disabled={!m.available} disabled={!m.available} data-testid={`model-${m.id}`} data-close-menu onClick={() => onSelect({ model: m.id })} className={cn(OPTION, m.id === selection.model && OPTION_ON, !m.available && "cursor-not-allowed opacity-55")}>
                        <Dot on={m.id === selection.model} />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="font-semibold">{m.label}</span>
                          <span className="font-dm-mono text-xs text-[color:var(--m-text-secondary)]">{m.id}</span>
                        </span>
                        <span className="text-[11px] font-semibold text-[color:var(--m-text-secondary)]">{!m.available ? "Unavailable now" : m.isDefault ? "Default" : ""}</span>
                      </button>
                    ))}
                  </div>
                  <span className="px-1 pt-1 text-xs text-[color:var(--m-text-secondary)]">Each reply shows what it cost. Prices follow the gateway&rsquo;s live rates.</span>
              </>
            </PillMenu>

            {chips}
          </div>
          {busy ? (
            <button type="button" data-testid="chat-stop" aria-label="Stop the reply" onClick={onStop} className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[color:var(--m-text-primary)] text-[color:var(--m-background)] hover:opacity-85">
              <Square aria-hidden className="h-3.5 w-3.5 fill-current" />
            </button>
          ) : (
            <button type="submit" data-testid="chat-send" aria-label="Send message" disabled={disabled || text.trim() === ""} className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[color:var(--m-primary)] text-[color:var(--m-on-primary)] motion-press hover:bg-[color:var(--m-primary-hover)] disabled:cursor-not-allowed disabled:bg-[color:var(--m-surface-2)] disabled:text-[color:var(--m-text-secondary)]">
              <ArrowUp aria-hidden className="h-[18px] w-[18px]" />
            </button>
          )}
        </div>
      </form>
      {disabledReason && (
        <p data-testid="chat-disabled-reason" className="text-[13px] text-[color:var(--m-text-secondary)]">
          {disabledReason}
        </p>
      )}
    </div>
  );
}
