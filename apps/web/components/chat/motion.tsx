import { cn } from "@repo/ui/cn";
import type { ActionRunState } from "@/lib/chat/actionRuns";

/*
 * The chat's motion. Every piece here only picks classes; the keyframes, their timings and the reduced-motion
 * rule live in app/globals.css. A loop is rendered ONLY while its work is pending: the caller mounts the cursor
 * and the dots for exactly as long as the request is, and the step pulse is on the active step of a live run.
 */

/** A bar after the text of a reply that is still streaming. Removed, not paused, when the reply ends. */
export function StreamingCursor() {
  return <span data-testid="streaming-cursor" aria-hidden="true" className="streaming-cursor" />;
}

/**
 * While a message is sent and nothing has come back yet. Visual only: `ThinkingStatus` says it to screen readers,
 * so the text is not read twice.
 */
export function PendingDots() {
  return (
    <p data-testid="pending-dots" aria-hidden="true" className="flex items-baseline gap-0.5 text-[13px] text-[color:var(--m-text-secondary)]">
      Thinking
      <span aria-hidden="true" className="inline-flex gap-0.5">
        <span className="pending-dot">.</span>
        <span className="pending-dot">.</span>
        <span className="pending-dot">.</span>
      </span>
    </p>
  );
}

/**
 * The chat's one live region. It stays mounted and only its text changes: a region inserted already holding its
 * text is often not announced by NVDA or JAWS.
 */
export function ThinkingStatus({ thinking }: { thinking: boolean }) {
  return (
    <p data-testid="chat-status" role="status" className="sr-only">
      {thinking ? "Thinking" : ""}
    </p>
  );
}

export const STEPS = ["build", "simulate", "approve", "confirm"] as const;

/**
 * Which of the four steps a run is on, from its real phase. Building and simulating both happen while the run is
 * `preparing` and the run does not say which, so `preparing` shows build. `queued` is waiting for the action before
 * it: its own work has not started, so nothing pulses. `done` is past the last step.
 */
export function stepFor(phase: ActionRunState["phase"]): { index: number; pending: boolean } {
  switch (phase) {
    case "queued":
      return { index: 0, pending: false };
    case "preparing":
      return { index: 0, pending: true };
    case "asking":
      return { index: 2, pending: true };
    case "confirming":
      return { index: 3, pending: true };
    case "done":
      return { index: STEPS.length, pending: false };
  }
}

/**
 * Whether this mounted card has watched its run while it was still going: once true, it stays true. Only then does a
 * confirmation draw its check. The run store keeps finished runs, so "a run exists" alone would redraw it for a card
 * that mounts again later (leaving the chat and coming back without a reload) and only ever saw it done.
 */
export function sawRunLive(sawLive: boolean, phase: ActionRunState["phase"] | undefined): boolean {
  return sawLive || (phase !== undefined && phase !== "done");
}

export function StepProgress({ phase }: { phase: ActionRunState["phase"] }) {
  const { index, pending } = stepFor(phase);
  const current = Math.min(index, STEPS.length - 1);
  return (
    <div
      data-testid="step-progress"
      role="progressbar"
      aria-label="Action progress"
      aria-valuetext={phase === "queued" ? "Waiting" : `Step ${current + 1} of ${STEPS.length}: ${STEPS[current]}`}
      aria-valuemin={1}
      aria-valuemax={STEPS.length}
      aria-valuenow={current + 1}
      className="grid grid-cols-4 gap-1"
    >
      {STEPS.map((step, i) => {
        const state = i < index ? "done" : i === index && pending ? "active" : "todo";
        return (
          <span
            key={step}
            data-state={state}
            className={cn(
              "motion-color h-1 rounded-full",
              // The theme-aware lime ink, as for every coloured mark: bright lime has no contrast on a light surface.
              state === "todo" ? "bg-[color:var(--m-text-secondary)] opacity-25" : "bg-[color:var(--m-primary-fg)]",
              state === "active" && "step-pulse",
            )}
          />
        );
      })}
    </div>
  );
}

/**
 * A check. `animate` draws it once as it mounts, for a result that arrived in this view; a result loaded from
 * history is simply shown. Either way it rests fully drawn: the animation only runs from empty to that state.
 */
export function CheckDraw({ animate }: { animate: boolean }) {
  return (
    <svg data-testid="check-draw" aria-hidden="true" viewBox="0 0 16 16" fill="none" className={cn("h-3.5 w-3.5 text-[color:var(--m-primary-fg)]", animate && "check-draw-animate")}>
      <path d="M3 8.5 6.5 12 13 4.5" pathLength={1} stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="check-draw-path" />
    </svg>
  );
}
