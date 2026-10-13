import { NextResponse, type NextRequest } from "next/server";
import { appOrigins, walletFrameHost, walletOrigin } from "@repo/wallet/frame/origins";
import { appChains } from "./lib/chains";
import { appCsp, newNonce, walletFrameCsp } from "./lib/security/csp";

const FRAME_PREFIX = "/wallet-frame";
const isDev = process.env.NODE_ENV === "development";

// `x-forwarded-host` is trusted here because the deployment edge overwrites it;
// a browser cannot set it on a navigation or an iframe load, so no page a victim
// opens can lie about its host. A non-browser client that forges it only changes
// what that client itself is served:
//  - forged on the wallet host: next.config's host-matched rewrite still blocks
//    every non-frame path there, so the app is not served on that origin;
//  - forged on the app host: the frame's HTML is returned to the forger, but no
//    browser storage exists in that exchange, so no key is exposed.
// Deployments whose edge does NOT overwrite this header must strip it upstream.
function requestHost(request: NextRequest): string {
  return request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "";
}

function rpcOrigins(): string[] {
  return Array.from(new Set(appChains.flatMap((chain) => chain.rpcUrls.default.http.map((url) => new URL(url).origin))));
}

/**
 * The frame pages: the strict policy, enforced. Next reads the nonce off the
 * REQUEST's CSP header when it renders and the browser reads it off the
 * RESPONSE's. Both, or the inline scripts Next emits carry no nonce and the
 * policy blocks the page it protects.
 */
function withWalletFrameHeaders(request: NextRequest): NextResponse {
  const nonce = newNonce();
  const csp = walletFrameCsp({ nonce, dev: isDev, appOrigins: appOrigins(), rpcOrigins: rpcOrigins() });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Cache-Control", "no-store");
  return response;
}

/**
 * The app pages: the full policy report-only. The ENFORCED header is not set
 * here: Next copies response headers a proxy sets back onto the request and
 * reads the nonce from `content-security-policy` first, so an enforced header
 * without a nonce would shadow the one with it. The enforced directives are
 * delivered by the `<meta http-equiv="Content-Security-Policy">` tag in
 * app/(app)/layout.tsx instead.
 */
function withAppHeaders(request: NextRequest): NextResponse {
  const nonce = newNonce();
  const csp = appCsp({ nonce, dev: isDev, walletOrigin: walletOrigin(), connectOrigins: rpcOrigins() });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp.reportOnly);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy-Report-Only", csp.reportOnly);
  response.headers.set("Reporting-Endpoints", csp.reportingEndpoints);
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  return response;
}

export default function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  const walletHost = walletFrameHost();
  const host = requestHost(request);

  if (pathname === FRAME_PREFIX || pathname.startsWith(`${FRAME_PREFIX}/`)) {
    // Configured but asked for on the wrong host: not served. The app host must
    // not serve the frame (its storage would then be the app's).
    if (walletHost && host !== walletHost) return new NextResponse(null, { status: 404 });
    return withWalletFrameHeaders(request);
  }

  // Anything else on the wallet host is refused: that origin serves the frame and nothing else.
  if (walletHost && host === walletHost) return new NextResponse(null, { status: 404 });

  return withAppHeaders(request);
}

export const config = {
  // Everything except route handlers, framework internals, and any path with a dot (static files).
  matcher: ["/((?!api|_next|_vercel|.*\\..*).*)"],
};
