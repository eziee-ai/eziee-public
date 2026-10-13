import localFont from "next/font/local";
import { DM_Mono } from "next/font/google";

export const satoshi = localFont({
  src: [
    { path: "../../../packages/ui/fonts/Satoshi-Variable.woff2", style: "normal" },
    { path: "../../../packages/ui/fonts/Satoshi-VariableItalic.woff2", style: "italic" },
  ],
  variable: "--font-satoshi",
  display: "swap",
});

export const dmMono = DM_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-dm-mono", display: "swap" });
