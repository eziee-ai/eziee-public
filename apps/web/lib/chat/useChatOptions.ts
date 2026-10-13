"use client";

import { useQuery } from "@tanstack/react-query";
import { useCallback, useState, useSyncExternalStore } from "react";
import { appChains, riseTestnet } from "@/lib/chains";
import { currentProtocolId } from "./legacyRate";

export interface ModelOption {
  id: string;
  label: string;
  available: boolean;
  isDefault: boolean;
}
export interface ProtocolOption {
  id: string;
  name: string;
  tier: string;
  chains: number[];
  capabilities: string[];
}

/**
 * What a chat is sent with (spec D12). It belongs to the CHAT: a saved chat reopens with the model, protocol and
 * network its last message used, which the server records. The browser only remembers the last choice so that a
 * NEW chat starts where the person left off.
 */
export interface ChatSelection {
  model: string;
  protocol: string;
  chainId: number;
}

const KEY = "wlt.chat-selection";
// RISE Testnet first: it is where Rate has live markets (Arc had none on 2026-10-08).
const DEFAULT: ChatSelection = { model: "openai/gpt-5.5", protocol: "auto", chainId: riseTestnet.id };

const listeners = new Set<() => void>();
let cached: { raw: string | null; value: ChatSelection } | null = null;

function read(): ChatSelection {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(KEY);
  } catch {
    raw = null;
  }
  if (cached && cached.raw === raw) return cached.value;
  let value = DEFAULT;
  try {
    const parsed = raw ? (JSON.parse(raw) as Partial<ChatSelection>) : {};
    const chainId = appChains.some((c) => c.id === parsed.chainId) ? (parsed.chainId as number) : DEFAULT.chainId;
    value = { model: typeof parsed.model === "string" ? parsed.model : DEFAULT.model, protocol: typeof parsed.protocol === "string" ? currentProtocolId(parsed.protocol) : DEFAULT.protocol, chainId };
  } catch {
    value = DEFAULT;
  }
  cached = { raw, value };
  return value;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A saved chat's own selection, made safe: a network this build no longer serves falls back rather than being sent. */
export function savedSelection(chat: { model: string; protocol: string; chainId: number }): ChatSelection {
  return { model: chat.model, protocol: chat.protocol, chainId: appChains.some((c) => c.id === chat.chainId) ? chat.chainId : DEFAULT.chainId };
}

/** `saved` is a saved chat's own selection. Without it (a new chat) the browser's last choice is used. */
export function useChatSelection(saved?: ChatSelection): [ChatSelection, (patch: Partial<ChatSelection>) => void] {
  const browser = useSyncExternalStore(subscribe, read, () => DEFAULT);
  const [own, setOwn] = useState<ChatSelection | undefined>(saved);
  const selection = own ?? browser;
  const update = useCallback((patch: Partial<ChatSelection>) => {
    setOwn((current) => (current ? { ...current, ...patch } : current));
    // The browser remembers what the person last CHOSE, for the next new chat, whichever chat they chose it in.
    const next = { ...read(), ...patch };
    try {
      window.localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // Private mode: the choice still applies to this page through the cache below.
      cached = { raw: null, value: next };
    }
    for (const listener of listeners) listener();
  }, []);
  return [selection, update];
}

export function useChatOptions() {
  return useQuery({
    queryKey: ["chat-options"],
    staleTime: 60_000,
    queryFn: async () => {
      const response = await fetch("/api/models");
      if (!response.ok) throw new Error("models");
      return (await response.json()) as { models: ModelOption[]; protocols: ProtocolOption[]; gatewayReachable: boolean };
    },
  });
}
