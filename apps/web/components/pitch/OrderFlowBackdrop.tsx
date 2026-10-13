"use client";

import { useEffect, useRef } from "react";

/**
 * The landing hero's background: columns of order-book prices streaming down, with fills printed in lime. Drawn on a
 * canvas behind the copy and faded out on the copy's side. With motion off it paints one still frame.
 */

const PALETTES = {
  dark: { ground: "#0d0e10", bid: "#a3a6ae", ask: "#62646c", fill: "#c6ff00" },
  light: { ground: "#f7f8fa", bid: "#62646c", ask: "#a3a6ae", fill: "#5d7a00" },
} as const;

/** On a phone the stream runs at this fraction of its desktop speed: a narrow screen makes the same fall feel faster. */
const PHONE_SPEED = 0.45;
const PHONE_MAX_WIDTH = 700;

/** The still frame shown when motion is off: far enough in that every column is populated. */
const STILL_SECONDS = 7.3;

interface Column {
  x: number;
  speed: number;
  offset: number;
  rows: Array<{ price: string; bid: boolean; fill: boolean }>;
}

/** A seeded random, so the book reads the same on every load. */
function seeded(seed: number) {
  return () => ((seed = (seed * 1_664_525 + 1_013_904_223) >>> 0) / 4_294_967_296);
}

function columnsFor(width: number, fontSize: number): Column[] {
  const random = seeded(7);
  const count = Math.max(6, Math.round(width / (fontSize * 5.2)));
  return Array.from({ length: count }, (_, i) => ({
    x: (i + 0.5) * (width / count),
    speed: 18 + random() * 40,
    offset: random() * 1000,
    rows: Array.from({ length: 40 }, () => ({ price: (1990 + random() * 20).toFixed(2), bid: random() > 0.5, fill: random() > 0.9 })),
  }));
}

function withAlpha(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

export function OrderFlowBackdrop({ theme, motion }: { theme: "light" | "dark"; motion: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext("2d");
    if (!element || !context) return;
    const palette = PALETTES[theme];
    // A canvas cannot read CSS variables, so the page's mono face is resolved once here.
    const mono = getComputedStyle(element).getPropertyValue("--font-dm-mono").trim() || '"DM Mono"';
    let width = 0;
    let height = 0;
    let fontSize = 10;
    let columns: Column[] = [];

    const resize = () => {
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      const box = element.getBoundingClientRect();
      width = Math.max(1, Math.round(box.width));
      height = Math.max(1, Math.round(box.height));
      element.width = Math.round(width * ratio);
      element.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      fontSize = Math.max(10, Math.round(width / 110));
      columns = columnsFor(width, fontSize);
    };

    const paint = (seconds: number) => {
      context.fillStyle = palette.ground;
      context.fillRect(0, 0, width, height);
      context.font = `500 ${fontSize}px ${mono}, "DM Mono", ui-monospace, monospace`;
      context.textAlign = "center";
      const step = fontSize * 1.9;
      for (const column of columns) {
        const travelled = seconds * column.speed + column.offset;
        const shift = travelled % step;
        const first = Math.floor(travelled / step);
        for (let k = -1; k < height / step + 1; k++) {
          const row = column.rows[(k + first + 400) % column.rows.length]!;
          const y = k * step + shift;
          const fade = Math.min(1, Math.max(0, y / (height * 0.9))) * 0.9;
          context.globalAlpha = row.fill ? 0.95 * fade + 0.05 : 0.28 * fade;
          context.fillStyle = row.fill ? palette.fill : row.bid ? palette.bid : palette.ask;
          context.fillText(row.price, column.x, y);
        }
      }
      context.globalAlpha = 1;
      // The copy sits on the left: the book fades back to the ground there so the headline stays clean.
      const fadeOut = context.createLinearGradient(0, 0, width * 0.75, 0);
      fadeOut.addColorStop(0, palette.ground);
      fadeOut.addColorStop(0.55, withAlpha(palette.ground, 0.82));
      fadeOut.addColorStop(1, withAlpha(palette.ground, 0));
      context.fillStyle = fadeOut;
      context.fillRect(0, 0, width, height);
    };

    resize();
    let frame = 0;
    let visible = true;
    const started = performance.now();
    const tick = (now: number) => {
      if (visible) paint(((now - started) / 1000) * (width <= PHONE_MAX_WIDTH ? PHONE_SPEED : 1));
      frame = requestAnimationFrame(tick);
    };
    if (motion) frame = requestAnimationFrame(tick);
    else paint(STILL_SECONDS);

    // Off screen, the book stops drawing.
    const observer = new IntersectionObserver(([entry]) => (visible = entry?.isIntersecting ?? true));
    observer.observe(element);
    const onResize = () => {
      resize();
      if (!motion) paint(STILL_SECONDS);
    };
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", onResize);
    };
  }, [theme, motion]);

  return <canvas ref={canvas} aria-hidden className="absolute inset-0 h-full w-full" />;
}
