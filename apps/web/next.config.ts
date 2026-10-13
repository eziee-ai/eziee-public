import type { NextConfig } from "next";
import { FRAME_ANCESTORS_HEADER } from "./lib/security/csp";

const walletHost = (() => {
  const raw = process.env.NEXT_PUBLIC_WALLET_ORIGIN?.trim();
  if (!raw) return null;
  try {
    return new URL(raw).host || null;
  } catch {
    return null;
  }
})();

const config: NextConfig = {
  transpilePackages: ["@repo/ui", "@repo/wallet", "@repo/protocols", "@repo/agent", "@repo/db"],
  // PGlite ships WASM and postgres.js uses Node sockets: both are loaded by Node at runtime, never bundled.
  serverExternalPackages: ["@electric-sql/pglite", "postgres"],
  async headers() {
    return [
      {
        // Only the frame-ancestors equivalent: a <meta> tag can't express
        // frame-ancestors, so it rides this header instead. The rest of the
        // app's enforced directives are delivered by the <meta http-equiv>
        // tag in app/(app)/layout.tsx, not a header — see lib/security/csp.ts
        // for why a nonce-less enforced Content-Security-Policy header here
        // would shadow the per-request nonce Next needs to tag its scripts.
        // `/wallet-frame*` is EXCLUDED: those pages are embedded by the app,
        // and their own enforced CSP comes from proxy.ts.
        source: "/:path((?!wallet-frame(?:/|$)|_next/|api/).*)",
        headers: [FRAME_ANCESTORS_HEADER],
      },
      {
        // The proxy does not run for /api, so these ride here. Every API body is JSON; nothing should guess otherwise.
        source: "/api/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
  async rewrites() {
    // The wallet host serves the wallet frame and NOTHING else.
    const beforeFiles = walletHost
      ? [
          {
            source: "/:path((?!wallet-frame(?:/|$)|_next/).*)",
            has: [{ type: "host" as const, value: walletHost.replace(/\./g, "\\.") }],
            destination: "/wallet-frame/blocked",
          },
        ]
      : [];
    return { beforeFiles, afterFiles: [], fallback: [] };
  },
};

export default config;
