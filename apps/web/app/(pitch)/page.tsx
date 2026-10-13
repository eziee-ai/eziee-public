import type { Metadata } from "next";
import { BRAND } from "@repo/ui/brand";
import { MotionPitch } from "@/components/pitch/MotionPitch";
import { LandingPage } from "@/components/pitch/LandingPage";
import { getJevEvidence } from "@/lib/jev-evidence";

export const metadata: Metadata = {
  title: `${BRAND} — Onchain? GGEZ.`,
  description: "Your AI desk for onchain. One intent. Every step handled. Join the eziee early access waitlist.",
};

export default async function LandingRoute({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  // Preserve the film renderer for exports; visitors get the scrolling landing page.
  if (query.render !== undefined || query.film === "1") return <MotionPitch />;
  return <LandingPage initialTheme={query.theme === "dark" ? "dark" : "light"} evidence={getJevEvidence()} />;
}
