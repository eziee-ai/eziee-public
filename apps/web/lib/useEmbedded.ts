import { useSyncExternalStore } from "react";

const never = () => () => {};

/**
 * Whether this page runs inside a frame. The server cannot know, so it renders
 * "not embedded" and the browser corrects it after hydration; reading `window`
 * while rendering instead makes the two disagree and React rebuilds the tree.
 */
export function useEmbedded(): boolean {
  return useSyncExternalStore(
    never,
    () => window.parent !== window,
    () => false,
  );
}
