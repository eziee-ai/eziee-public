"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Folder, FolderPlus, MoreHorizontal } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { startNewChat } from "@/lib/chat/newChat";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@repo/ui/cn";

export interface ChatRow {
  id: string;
  title: string;
  folderId?: string | null;
}

interface FolderRow {
  id: string;
  name: string;
}

const ROW = "flex min-h-11 min-w-0 flex-1 items-center gap-2.5 rounded-xl px-3 text-sm transition-colors hover:bg-[color:var(--m-surface-2)]";
const ROW_ON = "bg-[color:var(--m-surface-selected)] font-semibold text-[color:var(--m-on-surface-selected)]";
const LABEL = "px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-[color:var(--m-text-secondary)]";
const INPUT = "h-10 w-full min-w-0 rounded-xl border border-[color:var(--m-border-strong)] bg-transparent px-3 text-sm";
const MENU_ITEM = "flex min-h-10 w-full items-center rounded-lg px-3 text-left text-sm hover:bg-[color:var(--m-surface-2)] focus-visible:bg-[color:var(--m-surface-2)]";

/** Which folders are folded away, per device. Storage can be missing or refuse; the sidebar works either way. */
const FOLDED_KEY = "eziee.folders.folded";
function readFolded(): Set<string> {
  try {
    const raw = window.localStorage.getItem(FOLDED_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}
function writeFolded(folded: Set<string>) {
  try {
    window.localStorage.setItem(FOLDED_KEY, JSON.stringify([...folded]));
  } catch {
    // Not remembered on this device; it still folds for now.
  }
}

async function send(url: string, method: string, body?: unknown) {
  const response = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) throw new Error(((await response.json().catch(() => null)) as { error?: { message?: string } } | null)?.error?.message ?? "That did not work. Try again.");
  return response.json() as Promise<unknown>;
}

/**
 * The chat list, grouped like ChatGPT projects: folders first, each one folding away, then the chats in no folder.
 * While searching, the matches are listed flat, wherever they are filed.
 */
export function ChatHistory({ chats, searching, pathname, onNavigate }: { chats: ChatRow[]; searching: boolean; pathname: string; onNavigate?: () => void }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const folders = useQuery({
    queryKey: ["folders"],
    queryFn: async () => ((await (await fetch("/api/folders", { cache: "no-store" })).json()) as { folders: FolderRow[] }).folders,
  });
  // Only ever rendered in the browser (the chat list loads there), so storage can be read on first render.
  const [folded, setFolded] = useState<Set<string>>(readFolded);
  const [creating, setCreating] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const refresh = () => Promise.all([queryClient.invalidateQueries({ queryKey: ["folders"] }), queryClient.invalidateQueries({ queryKey: ["chats"] })]);
  const run = useMutation({
    mutationFn: ({ url, method, body }: { url: string; method: string; body?: unknown }) => send(url, method, body),
    onSuccess: () => (setProblem(null), void refresh()),
    onError: (error) => setProblem(error instanceof Error ? error.message : "That did not work. Try again."),
  });

  const toggle = (id: string) =>
    setFolded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      writeFolded(next);
      return next;
    });

  const list = folders.data ?? [];
  const known = new Set(list.map((f) => f.id));
  const loose = chats.filter((c) => !c.folderId || !known.has(c.folderId));
  const chatRow = (chat: ChatRow, nested: boolean) => (
    <ChatItem key={chat.id} chat={chat} nested={nested} active={pathname === `/c/${chat.id}`} folders={list} onNavigate={onNavigate} onMove={(folderId) => run.mutate({ url: `/api/chats/${chat.id}`, method: "PATCH", body: { folderId } })} />
  );

  if (searching) return <>{chats.map((chat) => chatRow(chat, false))}</>;

  return (
    <>
      <div className="flex items-center justify-between">
        <span className={LABEL}>Folders</span>
        <button type="button" data-testid="folder-new" aria-label="New folder" title="New folder" onClick={() => setCreating(true)} className="grid h-9 w-9 place-items-center rounded-lg text-[color:var(--m-text-secondary)] hover:bg-[color:var(--m-surface-2)] hover:text-[color:var(--m-text-primary)]">
          <FolderPlus aria-hidden className="h-4 w-4" />
        </button>
      </div>
      {creating && <NameInput label="New folder name" testId="folder-name" initial="" onDone={(name) => (setCreating(false), name !== null && run.mutate({ url: "/api/folders", method: "POST", body: { name } }))} />}
      {problem && (
        <p role="alert" className="px-3 py-1 text-[13px] text-[color:var(--m-error-fg)]">
          {problem}
        </p>
      )}
      {list.map((folder) => {
        const inside = chats.filter((c) => c.folderId === folder.id);
        const open = !folded.has(folder.id);
        return (
          <FolderItem key={folder.id} folder={folder} open={open} count={inside.length} onToggle={() => toggle(folder.id)} onRename={(name) => run.mutate({ url: `/api/folders/${folder.id}`, method: "PATCH", body: { name } })} onDelete={() => run.mutate({ url: `/api/folders/${folder.id}`, method: "DELETE" })} onNewChat={() => (startNewChat(), router.push(`/home?folder=${folder.id}`))}>
            {open && (inside.length > 0 ? inside.map((chat) => chatRow(chat, true)) : <p className="py-1.5 pl-10 pr-3 text-[13px] text-[color:var(--m-text-secondary)]">No chats here yet. Use a chat&rsquo;s ⋯ menu to move it in.</p>)}
          </FolderItem>
        );
      })}
      {list.length === 0 && !creating && <p className="px-3 pb-1 text-[13px] text-[color:var(--m-text-secondary)]">Group chats into folders with the + button.</p>}
      <span className={LABEL}>Chats</span>
      {loose.length === 0 ? <p className="px-3 py-1.5 text-[13px] text-[color:var(--m-text-secondary)]">{chats.length === 0 ? "No chats yet." : "Every chat is in a folder."}</p> : loose.map((chat) => chatRow(chat, false))}
    </>
  );
}

/** A name typed in place. Enter keeps it, Escape or an empty name cancels; leaving the field keeps what was typed. */
function NameInput({ label, testId, initial, onDone }: { label: string; testId: string; initial: string; onDone: (name: string | null) => void }) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (name: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(name && name.trim() ? name.trim() : null);
  };
  return (
    <div className="px-1 py-0.5">
      <input
        autoFocus
        aria-label={label}
        data-testid={testId}
        value={value}
        maxLength={60}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === "Escape") {
            e.preventDefault();
            finish(e.key === "Enter" ? value : null);
          }
        }}
        onBlur={() => finish(value)}
        className={INPUT}
      />
    </div>
  );
}

function FolderItem({ folder, open, count, onToggle, onRename, onDelete, onNewChat, children }: { folder: FolderRow; open: boolean; count: number; onToggle: () => void; onRename: (name: string) => void; onDelete: () => void; /** Opens a new chat that is filed here when it starts. */ onNewChat: () => void; children: ReactNode }) {
  const [renaming, setRenaming] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const regionId = useId();
  return (
    <div data-testid={`folder-${folder.id}`} className="flex flex-col">
      {renaming ? (
        <NameInput label={`Rename ${folder.name}`} testId="folder-rename-input" initial={folder.name} onDone={(name) => (setRenaming(false), name !== null && name !== folder.name && onRename(name))} />
      ) : (
        <div className="group flex items-center">
          <button type="button" data-testid="folder-toggle" aria-expanded={open} aria-controls={regionId} onClick={onToggle} className={cn(ROW, "font-medium")}>
            <ChevronRight aria-hidden className={cn("h-3.5 w-3.5 shrink-0 text-[color:var(--m-text-secondary)] transition-transform motion-reduce:transition-none", open && "rotate-90")} />
            <Folder aria-hidden className="h-4 w-4 shrink-0 text-[color:var(--m-text-secondary)]" />
            <span className="truncate">{folder.name}</span>
            <span className="ml-auto pl-1 text-xs text-[color:var(--m-text-secondary)]">{count}</span>
          </button>
          <RowMenu label={`${folder.name} options`} testId="folder-menu">
            <>
                <button type="button" role="menuitem" data-testid="folder-new-chat" className={MENU_ITEM} onClick={onNewChat}>
                  New chat in folder
                </button>
                <button type="button" role="menuitem" className={MENU_ITEM} onClick={() => setRenaming(true)}>
                  Rename
                </button>
                <button type="button" role="menuitem" className={cn(MENU_ITEM, "text-[color:var(--m-error-fg)]")} onClick={() => setConfirming(true)}>
                  Delete
                </button>
            </>
          </RowMenu>
        </div>
      )}
      {confirming && (
        <div role="group" aria-label={`Delete ${folder.name}`} className="mx-1 my-1 flex flex-col gap-2 rounded-xl border border-[color:var(--m-border)] p-3 text-[13px]">
          <span>
            Delete &ldquo;{folder.name}&rdquo;? Its chats are kept and move to Chats.
          </span>
          <span className="flex gap-2">
            <button type="button" autoFocus data-testid="folder-delete-confirm" onClick={() => (setConfirming(false), onDelete())} className="min-h-9 rounded-lg bg-[color:var(--m-error-fg)] px-3 font-semibold text-[color:var(--m-background)]">
              Delete folder
            </button>
            <button type="button" onClick={() => setConfirming(false)} className="min-h-9 rounded-lg border border-[color:var(--m-border)] px-3 font-semibold hover:bg-[color:var(--m-surface-2)]">
              Cancel
            </button>
          </span>
        </div>
      )}
      <div id={regionId} className="flex flex-col gap-0.5">
        {children}
      </div>
    </div>
  );
}

function ChatItem({ chat, nested, active, folders, onNavigate, onMove }: { chat: ChatRow; nested: boolean; active: boolean; folders: FolderRow[]; onNavigate?: () => void; onMove: (folderId: string | null) => void }) {
  return (
    <div data-testid="chat-row" className={cn("group flex items-center", nested && "pl-5")}>
      <Link href={`/c/${chat.id}`} onClick={onNavigate} aria-current={active ? "page" : undefined} className={cn(ROW, active && ROW_ON)}>
        <span className="truncate">{chat.title}</span>
      </Link>
      <RowMenu label={`${chat.title} options`} testId="chat-menu">
        <>
            <span className="px-3 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-[color:var(--m-text-secondary)]">Move to folder</span>
            {folders.length === 0 && <span className="px-3 py-1.5 text-[13px] text-[color:var(--m-text-secondary)]">No folders yet. Make one with the + beside Folders.</span>}
            {folders
              .filter((f) => f.id !== chat.folderId)
              .map((f) => (
                <button key={f.id} type="button" role="menuitem" data-testid="move-to-folder" className={MENU_ITEM} onClick={() => onMove(f.id)}>
                  <Folder aria-hidden className="mr-2 h-4 w-4 shrink-0 text-[color:var(--m-text-secondary)]" />
                  <span className="truncate">{f.name}</span>
                </button>
              ))}
            {chat.folderId && (
              <button type="button" role="menuitem" data-testid="remove-from-folder" className={MENU_ITEM} onClick={() => onMove(null)}>
                Remove from folder
              </button>
            )}
        </>
      </RowMenu>
    </div>
  );
}

/**
 * A ⋯ button with a small menu. Shown on hover or focus of its row (always on touch screens). Arrow keys move
 * between items, Escape and a click outside close it, and focus goes back to the button.
 */
function RowMenu({ label, testId, children }: { label: string; testId: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  // Placed against the window, not the row: the chat list scrolls, and a menu inside it would be cut off.
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const toggle = () => {
    const rect = button.current?.getBoundingClientRect();
    if (rect) setAt({ top: Math.min(rect.bottom + 4, window.innerHeight - 240), right: Math.max(8, window.innerWidth - rect.right) });
    setOpen((v) => !v);
  };

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
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
  const onKeyDown = (event: KeyboardEvent) => {
    if (!open) return;
    if (event.key === "Escape") return (event.preventDefault(), event.stopPropagation(), close());
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const at = items.indexOf(document.activeElement as HTMLElement);
    items[(at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  };

  return (
    <div ref={root} className="relative" onKeyDown={onKeyDown}>
      <button
        ref={button}
        type="button"
        data-testid={testId}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={toggle}
        className={cn(
          "grid h-9 w-9 shrink-0 place-items-center rounded-lg text-[color:var(--m-text-secondary)] hover:bg-[color:var(--m-surface-2)] hover:text-[color:var(--m-text-primary)]",
          // Hidden until the row is hovered or something in it has focus; always there where there is no hover.
          !open && "[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:opacity-100",
        )}
      >
        <MoreHorizontal aria-hidden className="h-4 w-4" />
      </button>
      {open && (
        <div
          ref={menu}
          id={menuId}
          role="menu"
          aria-label={label}
          // Choosing an item closes the menu; the item's own click has already run.
          onClick={(event) => {
            if ((event.target as HTMLElement).closest('[role="menuitem"]')) close();
          }} style={at ? { top: at.top, right: at.right } : undefined} className="fixed z-50 flex max-h-60 w-56 flex-col gap-0.5 overflow-y-auto rounded-xl border border-[color:var(--m-border)] bg-[color:var(--m-surface)] p-1.5 shadow-xl">
          {children}
        </div>
      )}
    </div>
  );
}
