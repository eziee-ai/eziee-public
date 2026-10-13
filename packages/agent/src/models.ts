import { parsePrice, type ModelPrice } from "./pricing";

/**
 * Which models the picker offers (spec §7.3): this allowlist INTERSECTED with
 * the gateway's live model list, so a model removed upstream disappears from the
 * picker instead of erroring, and every offered model has a price to meter by.
 */

export const DEFAULT_MODEL = "openai/gpt-5.5";

/**
 * Order is the picker's order. Ids verified against the gateway on 2026-09-20 (GPT-5.5 and DeepSeek V4 Flash on
 * 2026-10-08). Prices always come from the gateway's listing; `openai/*` models are CALLED directly with
 * OPENAI_API_KEY when it is set (apps/web/lib/server/languageModel.ts).
 */
export const MODEL_ALLOWLIST: ReadonlyArray<{ id: string; label: string }> = [
  { id: "openai/gpt-5.5", label: "GPT-5.5" },
  { id: "moonshotai/kimi-k3", label: "Kimi K3" },
  { id: "moonshotai/kimi-k3-fast", label: "Kimi K3 Fast" },
  { id: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5" },
  // Served on the gateway's free tier too (checked 2026-10-08), so a fresh gateway account can chat.
  { id: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash" },
];

export interface AvailableModel {
  id: string;
  label: string;
  price: ModelPrice;
  isDefault: boolean;
  /** How many tokens one prompt may hold, as the gateway lists it. */
  contextWindow: number;
}

/** Used when the gateway does not say a model's window. Small enough to be true of every model on the allowlist. */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

const contextWindow = (value: unknown): number => (typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_CONTEXT_WINDOW);

const GATEWAY_MODELS_URL = "https://ai-gateway.vercel.sh/v1/models";
const CACHE_MS = 10 * 60_000;

type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/** After a failed listing, do not ask again for this long: an outage must not add a timeout to every request. */
const RETRY_AFTER_FAILURE_MS = 30_000;
/** A listing this old may still be served while the gateway cannot be asked. Prices rarely move; an hour is the limit. */
const STALE_IF_ERROR_MS = 60 * 60_000;

let cache: { at: number; models: AvailableModel[] } | null = null;
let failedAt: number | null = null;

export function resetModelCacheForTests(): void {
  cache = null;
  failedAt = null;
}

/** Allowlisted models the gateway serves right now, each with a usable price. Cached for ten minutes. */
export async function availableModels(options: { fetch?: Fetch; now?: number } = {}): Promise<AvailableModel[]> {
  const now = options.now ?? Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache.models;

  const unavailable = () => {
    if (cache && now - cache.at < STALE_IF_ERROR_MS) return cache.models;
    throw new Error("The model gateway did not list its models.");
  };
  if (failedAt !== null && now - failedAt < RETRY_AFTER_FAILURE_MS) return unavailable();

  const doFetch: Fetch = options.fetch ?? ((url, init) => fetch(url, init));
  let body: { data?: Array<{ id?: unknown; pricing?: unknown; context_window?: unknown }> };
  try {
    const response = await doFetch(GATEWAY_MODELS_URL, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error("not ok");
    body = (await response.json()) as typeof body;
  } catch {
    failedAt = now;
    return unavailable();
  }
  failedAt = null;
  const listed = new Map((body.data ?? []).filter((m): m is { id: string; pricing?: unknown; context_window?: unknown } => typeof m.id === "string").map((m) => [m.id, m]));

  const models = MODEL_ALLOWLIST.flatMap((entry) => {
    const listing = listed.get(entry.id);
    const price = parsePrice(listing?.pricing);
    // Not listed upstream, or listed without a price we can bill from: not offered (spec §14.2).
    return price ? [{ ...entry, price, isDefault: entry.id === DEFAULT_MODEL, contextWindow: contextWindow(listing?.context_window) }] : [];
  });
  cache = { at: now, models };
  return models;
}

/** The requested model if it is on offer, else null. Never falls back silently to a different (differently priced) model. */
export async function resolveModel(id: string, options: { fetch?: Fetch; now?: number } = {}): Promise<AvailableModel | null> {
  return (await availableModels(options)).find((m) => m.id === id) ?? null;
}
