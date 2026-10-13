export const DURATION = 42;
export const CHAPTERS = [
  { start: 0, end: 5, label: "The desk", title: "Onchain? GGEZ.", caption: "Your intent is the starting point." },
  { start: 5, end: 10, label: "The friction", title: "One intent. Too many tabs.", caption: "Markets, protocols, quotes. Bring the work into one place." },
  { start: 10, end: 17, label: "The desk", title: "Your next move. One desk.", caption: "Describe the outcome. The desk prepares the action." },
  { start: 17, end: 24, label: "The decision", title: "State in. Decision out.", caption: "Jev is built for fast, structured decisions software can use." },
  { start: 24, end: 30, label: "The connections", title: "One desk. Open connections.", caption: "Rate is one integration. More protocols connect through MCP." },
  { start: 30, end: 36, label: "Your control", title: "Fast decisions. Your permission.", caption: "Your wallet checks the action and enforces your permissions." },
  { start: 36, end: 42, label: "Next move", title: "Your intent. Into action.", caption: "An AI desk for using onchain protocols." },
] as const;

export function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

export function chapterAt(time: number): number {
  return CHAPTERS.findIndex((chapter, index) => time >= chapter.start && (time < chapter.end || index === CHAPTERS.length - 1));
}

export function progress(time: number, start: number, duration = 0.65): number {
  return clamp((time - start) / duration);
}

export function easeOut(value: number): number {
  return 1 - (1 - clamp(value)) ** 4;
}
