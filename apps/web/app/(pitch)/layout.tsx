import type { ReactNode } from "react";
import { dmMono, satoshi } from "@/lib/fonts";
import { ENFORCED_META_CSP } from "@/lib/security/csp";
import "../globals.css";
import "@designcodeio/threeui/style.css";

export const dynamic = "force-dynamic";

export default function PitchLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${satoshi.variable} ${dmMono.variable}`}>
      <head><meta httpEquiv="Content-Security-Policy" content={ENFORCED_META_CSP} /></head>
      <body className="font-satoshi antialiased">{children}</body>
    </html>
  );
}
