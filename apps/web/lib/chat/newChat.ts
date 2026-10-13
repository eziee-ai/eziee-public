import { useSyncExternalStore } from "react";

/**
 * "New chat" while a new chat is already open. The first reply moves the address
 * bar to /c/<id> without a navigation (so the stream survives), which leaves the
 * home page mounted: a link back to "/home" would change nothing. Each press bumps a
 * generation that keys the view, so the conversation really starts over.
 */
let generation = 0;
const listeners = new Set<() => void>();

export function startNewChat(): void {
  generation += 1;
  for (const listener of listeners) listener();
}

export function useNewChatGeneration(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => generation,
    () => 0,
  );
}
