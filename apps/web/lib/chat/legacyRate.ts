/**
 * Iter now ships as Rate (2026-10-08): the protocol id `iter` became `rate` and its tools `iter_*` became `rate_*`.
 * Saved chats were migrated in the database (packages/db 0004_rate_protocol_id); these cover what is still in
 * flight: a tab opened before the change sends its history and its saved choice with the old names.
 */

const LEGACY_ID = "iter";
const CURRENT_ID = "rate";

/** A protocol id as saved before the rename, as it is now. */
export function currentProtocolId(id: string): string {
  return id === LEGACY_ID ? CURRENT_ID : id;
}

/** A tool name as saved before the rename, as it is now: `iter_swap` → `rate_swap`. */
function currentToolName(name: string): string {
  return name.startsWith(`${LEGACY_ID}_`) ? `${CURRENT_ID}_${name.slice(LEGACY_ID.length + 1)}` : name;
}

/** Renames old tool parts (`tool-iter_*`, and a dynamic tool's `toolName`) in UI messages. Text is never touched. */
export function renameLegacyToolParts(messages: unknown[]): unknown[] {
  return messages.map((message) => {
    if (typeof message !== "object" || message === null || !Array.isArray((message as { parts?: unknown }).parts)) return message;
    const parts = (message as { parts: unknown[] }).parts.map((part) => {
      if (typeof part !== "object" || part === null) return part;
      const p = part as { type?: unknown; toolName?: unknown };
      let next = part as Record<string, unknown>;
      if (typeof p.type === "string" && p.type.startsWith(`tool-${LEGACY_ID}_`)) next = { ...next, type: `tool-${currentToolName(p.type.slice("tool-".length))}` };
      if (p.type === "dynamic-tool" && typeof p.toolName === "string") next = { ...next, toolName: currentToolName(p.toolName) };
      return next;
    });
    return { ...(message as object), parts };
  });
}
