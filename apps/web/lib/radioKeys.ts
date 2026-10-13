import type { KeyboardEvent } from "react";

/**
 * Arrow keys for a `role="radiogroup"`: Up/Left and Down/Right move between the enabled radios, Home and End jump
 * to the ends, wrapping. They move FOCUS only; Space or Enter chooses. These groups live in menus that close when
 * a choice is made, and a menu that closed on every arrow press could not be browsed.
 * Pair with a roving tabindex (`rovingTabIndex`) so the group is one Tab stop.
 */
export function radioKeys(event: KeyboardEvent<HTMLElement>): void {
  const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
  if (step === undefined && event.key !== "Home" && event.key !== "End") return;
  const radios = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]:not([disabled])'));
  if (radios.length === 0) return;
  const at = radios.indexOf(document.activeElement as HTMLElement);
  const next = event.key === "Home" ? 0 : event.key === "End" ? radios.length - 1 : (Math.max(at, 0) + step! + radios.length) % radios.length;
  event.preventDefault();
  radios[next]?.focus();
}

/** One Tab stop per group: the chosen radio, or the first when nothing in the group is chosen. */
export const rovingTabIndex = (checked: boolean, isFirst: boolean, anyChecked: boolean): 0 | -1 => (checked || (!anyChecked && isFirst) ? 0 : -1);
