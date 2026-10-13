import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CheckDraw, PendingDots, STEPS, StepProgress, StreamingCursor, ThinkingStatus, sawRunLive, stepFor } from "./motion";

const segments = (html: string) => [...html.matchAll(/data-state="(\w+)"/g)].map((m) => m[1]);

describe("stepFor", () => {
  it("maps each real run phase to the step it is on", () => {
    // The run does not expose simulation apart from building, so `preparing` is build and simulate is never active.
    expect(stepFor("queued")).toEqual({ index: 0, pending: false });
    expect(stepFor("preparing")).toEqual({ index: 0, pending: true });
    expect(stepFor("asking")).toEqual({ index: 2, pending: true });
    expect(stepFor("confirming")).toEqual({ index: 3, pending: true });
    expect(stepFor("done")).toEqual({ index: 4, pending: false });
  });
});

describe("StepProgress", () => {
  it("names the four steps in order", () => {
    expect(STEPS).toEqual(["build", "simulate", "approve", "confirm"]);
  });

  it("while asking: build and simulate are done, approve is active, confirm is still to come", () => {
    const html = renderToStaticMarkup(<StepProgress phase="asking" />);
    expect(html).toContain('aria-label="Action progress"');
    expect(html).toContain('aria-valuetext="Step 3 of 4: approve"');
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="3"');
    expect(segments(html)).toEqual(["done", "done", "active", "todo"]);
    // Coloured marks use the theme-aware lime ink: bright lime on a light surface is about 1.2:1.
    expect(html).toContain("bg-[color:var(--m-primary-fg)]");
    expect(html).not.toContain("bg-[color:var(--m-primary)]");
  });

  it("while confirming: only confirm is active", () => {
    const html = renderToStaticMarkup(<StepProgress phase="confirming" />);
    expect(html).toContain('aria-valuetext="Step 4 of 4: confirm"');
    expect(segments(html)).toEqual(["done", "done", "done", "active"]);
  });

  it("while preparing: build is active", () => {
    const html = renderToStaticMarkup(<StepProgress phase="preparing" />);
    expect(html).toContain('aria-valuetext="Step 1 of 4: build"');
    expect(segments(html)).toEqual(["active", "todo", "todo", "todo"]);
  });

  it("while queued behind another action nothing pulses: that run's work has not started", () => {
    const html = renderToStaticMarkup(<StepProgress phase="queued" />);
    expect(html).toContain('aria-valuetext="Waiting"');
    expect(segments(html)).toEqual(["todo", "todo", "todo", "todo"]);
    expect(html).not.toContain("step-pulse");
  });

  it("only the active segment carries the pulse", () => {
    const html = renderToStaticMarkup(<StepProgress phase="asking" />);
    expect(html.match(/step-pulse/g)).toHaveLength(1);
  });
});

describe("CheckDraw", () => {
  it("draws itself only when asked to", () => {
    const drawn = renderToStaticMarkup(<CheckDraw animate />);
    expect(drawn).toContain('data-testid="check-draw"');
    expect(drawn).toContain("check-draw-animate");
  });

  it("renders a finished, static check otherwise (a result loaded from history)", () => {
    const still = renderToStaticMarkup(<CheckDraw animate={false} />);
    expect(still).toContain('data-testid="check-draw"');
    expect(still).not.toContain("check-draw-animate");
    expect(still).toContain('aria-hidden="true"');
  });
});

describe("pending indicators", () => {
  it("the cursor is hidden from assistive tech", () => {
    const html = renderToStaticMarkup(<StreamingCursor />);
    expect(html).toContain('data-testid="streaming-cursor"');
    expect(html).toContain('aria-hidden="true"');
  });

  it("the visible dots say Thinking but are hidden from assistive tech, so the status alone reads it", () => {
    const html = renderToStaticMarkup(<PendingDots />);
    expect(html).toContain('data-testid="pending-dots"');
    expect(html).toContain("Thinking");
    expect(html).not.toContain('role="status"');
    expect(html).toMatch(/^<p [^>]*aria-hidden="true"/);
    expect(html.match(/class="pending-dot"/g)).toHaveLength(3);
  });

  it("the status is always mounted and empty while nothing is pending", () => {
    // A live region inserted already holding its text is often not announced, so the region stays and its text changes.
    const html = renderToStaticMarkup(<ThinkingStatus thinking={false} />);
    expect(html).toBe('<p data-testid="chat-status" role="status" class="sr-only"></p>');
  });

  it("the status says Thinking while a reply is pending, and is never aria-hidden", () => {
    const html = renderToStaticMarkup(<ThinkingStatus thinking />);
    expect(html).toBe('<p data-testid="chat-status" role="status" class="sr-only">Thinking</p>');
    expect(html).not.toContain("aria-hidden");
  });
});

describe("sawRunLive", () => {
  it("stays false for a result this view never watched running (history, or a finished run kept in memory)", () => {
    expect(sawRunLive(false, undefined)).toBe(false);
    expect(sawRunLive(false, "done")).toBe(false);
  });

  it("turns true once the run is seen before it is done, and stays true after it finishes", () => {
    for (const phase of ["queued", "preparing", "asking", "confirming"] as const) expect(sawRunLive(false, phase)).toBe(true);
    expect(sawRunLive(true, "done")).toBe(true);
    expect(sawRunLive(true, undefined)).toBe(true);
  });
});
