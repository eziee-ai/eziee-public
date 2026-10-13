/**
 * Content Security Policy, for both origins this deployment serves.
 *
 * Two policies, because the two origins have opposite problems.
 *
 * ## The wallet frame: strict, enforced, small surface
 *
 * `/wallet-frame*` runs nothing but the frame and holds the key. Its policy
 * is enforced from day one: nonce-only scripts, connect to the chain RPCs and
 * nothing else, embeddable by the app origins alone. See `walletFrameCsp`.
 *
 * ## The app: enforce what cannot break, REPORT the rest first
 *
 * The app will load resources a policy written from reading the code cannot
 * fully predict: token logos from whatever host a token list names, QR codes,
 * public RPCs, and third-party SDKs whose API hosts are not in their published
 * types. (This reasoning is ported from Rate, where a charting bundle and
 * analytics made it concrete; the same applies here as adapters land.) A
 * strict policy WILL be wrong somewhere, and a wrong enforced CSP fails
 * silently: the page renders, a logo or a balance is simply missing, and
 * nothing says why.
 *
 * So the app ships two headers:
 *
 *  - The ENFORCED part, holding only the directives no resource on the page
 *    can trip: `frame-ancestors 'self'` (clickjacking), `object-src 'none'`,
 *    `base-uri 'self'`. Real protection, zero risk. Delivered as
 *    `X-Frame-Options: SAMEORIGIN` plus a meta tag — see
 *    ENFORCED_META_DIRECTIVES for why it must not be a `Content-Security-Policy` header.
 *  - `Content-Security-Policy-Report-Only`, holding the full policy. The
 *    browser evaluates it, blocks nothing, and posts every violation to
 *    `/api/csp-report`, which logs them. Once the logs are quiet for a
 *    representative stretch of use, promote it: in `proxy.ts`'s
 *    `withAppHeaders` set the RESPONSE header `Content-Security-Policy` to
 *    `csp.reportOnly` (it carries the nonce, so being copied onto the request
 *    is then harmless), and keep the report-only header for a release to
 *    catch stragglers. The meta tag and X-Frame-Options can stay.
 *
 * Nonces need dynamic rendering: Next tags scripts with a nonce only when it
 * renders the page for that request. Both root layouts, `app/(app)/layout.tsx`
 * and `app/wallet-frame/layout.tsx`, export `dynamic = "force-dynamic"` for
 * exactly this reason.
 *
 * ## Pure
 *
 * No I/O: the inputs are the nonce and the hosts, so the policy that gates
 * every script on the site has a test for its shape.
 */

export interface AppCspInput {
  nonce: string;
  /** `'unsafe-eval'` for React's dev tooling and the HMR socket; never in production. */
  dev: boolean;
  /** Where the wallet frame is served, for `frame-src`. */
  walletOrigin: string;
  /** Gateway, aggregator and RPC origins the browser connects to directly. */
  connectOrigins: readonly string[];
}

export interface AppCsp {
  /** The enforced directives as one string, for reference and tests; delivered by meta + X-Frame-Options, never as a header. */
  enforced: string;
  /** The `Content-Security-Policy-Report-Only` header: the full policy, reporting. */
  reportOnly: string;
  /** The `Reporting-Endpoints` header the `report-to` directive names. */
  reportingEndpoints: string;
}

export const CSP_REPORT_PATH = "/api/csp-report";
const REPORT_GROUP = "csp";

/**
 * The directives the app enforces today. Nothing on the page can trip these.
 *
 * They are NOT sent as a `Content-Security-Policy` header, and the reason is
 * what cost three preview deployments: on Vercel, every `headers()` entry from
 * next.config.ts is applied to the REQUEST the render receives as well as to
 * the response, and Next reads its script nonce from the request's
 * `content-security-policy` before ever looking at the report-only header. A
 * nonce-less enforced header under that name therefore silently untagged
 * every Next chunk (1 of 45 scripts carried the nonce). Locally the same
 * shadowing happens by a different route: the proxy's response headers are
 * copied onto the request.
 *
 * So the enforced part rides two carriers Next never reads and browsers
 * honour everywhere: `X-Frame-Options: SAMEORIGIN` for the clickjacking rule
 * (equivalent to `frame-ancestors 'self'`), and a `<meta http-equiv>` tag in
 * the layout for the directives meta supports. `frame-ancestors` and
 * `report-uri` are ignored in meta by spec, which is why the split is exactly
 * this.
 */
/**
 * Images: this origin, and inline data (QR codes and wallet icons are data: URLs). ENFORCED, unlike most of the
 * app's policy, because the chat renders text a model wrote, and the model reads text strangers wrote (a token's
 * onchain name). An image URL is a request that leaves the moment it renders, carrying whatever was put in it.
 * The markdown renderer already refuses images; this holds even if that ever changes.
 */
const IMG_SRC = "img-src 'self' data: blob:";
export const ENFORCED_META_DIRECTIVES = ["object-src 'none'", "base-uri 'self'", IMG_SRC] as const;
/** For the `<meta http-equiv="Content-Security-Policy">` tag in the app layout. */
export const ENFORCED_META_CSP = ENFORCED_META_DIRECTIVES.join("; ");
/** The header pair that carries the clickjacking rule without the CSP header name. */
export const FRAME_ANCESTORS_HEADER = { key: "X-Frame-Options", value: "SAMEORIGIN" } as const;
/** Every enforced directive, for inclusion in the report-only policy too. */
export const ENFORCED_DIRECTIVES = ["frame-ancestors 'self'", ...ENFORCED_META_DIRECTIVES] as const;

function dedupe(values: readonly string[]): string[] {
  return Array.from(new Set(values.filter((v) => v.length > 0)));
}

export function appCsp(input: AppCspInput): AppCsp {
  const { nonce, dev, walletOrigin, connectOrigins } = input;
  const connect = dedupe([
    "'self'",
    ...connectOrigins,
    ...(dev ? ["ws:", "wss:"] : []),
  ]);

  const full = [
    "default-src 'self'",
    // Nonce + strict-dynamic: only scripts Next tags with this request's nonce
    // run, plus whatever THEY load (TradingView's bundle loads its own
    // pieces; the analytics script injects itself). `'self'` is for browsers
    // that predate strict-dynamic and is ignored by those that have it.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    // Inline STYLE attributes are everywhere in a Tailwind app (React's
    // style={}); they cannot exfiltrate anything, unlike inline script.
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    `connect-src ${connect.join(" ")}`,
    // The wallet's two frames, and TradingView's own same-origin iframe.
    `frame-src 'self' ${walletOrigin}`,
    "worker-src 'self' blob:",
    "media-src 'self' data: blob:",
    "manifest-src 'self'",
    "form-action 'self'",
    ...ENFORCED_DIRECTIVES,
    `report-uri ${CSP_REPORT_PATH}`,
    `report-to ${REPORT_GROUP}`,
  ];

  return {
    enforced: ENFORCED_DIRECTIVES.join("; "),
    reportOnly: full.join("; "),
    reportingEndpoints: `${REPORT_GROUP}="${CSP_REPORT_PATH}"`,
  };
}

export interface WalletFrameCspInput {
  nonce: string;
  dev: boolean;
  /** The app origins allowed to embed the frame. */
  appOrigins: readonly string[];
  /** The chain RPC origins the frame broadcasts to and reads token facts from. */
  rpcOrigins: readonly string[];
}

/**
 * The frame pages' CSP. Strict where it can be, and every relaxation is named:
 *
 *   - `script-src` is nonce + `'strict-dynamic'`: only scripts Next tags with
 *     this request's nonce run, and the scripts they load. `'self'` is listed
 *     for browsers that predate strict-dynamic.
 *   - `style-src 'unsafe-inline'`: React `style={}` attributes are inline
 *     styles under CSP, and the frame uses one for its height. Inline STYLE
 *     cannot exfiltrate a key; inline SCRIPT can, and that one stays nonce-only.
 *   - `connect-src`: the chains' RPC origins, for the broadcast and the token
 *     lookups — nothing else, so a compromised dependency has nowhere to send
 *     anything.
 *   - `frame-ancestors`: the app origins alone. That is the clickjacking rule
 *     for the confirm button: no other site can embed it.
 *   - `default-src 'none'`, `object-src 'none'`, `base-uri 'none'`,
 *     `form-action 'none'`: the page needs none of them.
 */
export function walletFrameCsp(input: WalletFrameCspInput): string {
  const { nonce, dev, appOrigins, rpcOrigins } = input;
  const ancestors = dedupe(appOrigins);
  return [
    "default-src 'none'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self' ${dedupe(rpcOrigins).join(" ")}${dev ? " ws: wss:" : ""}`,
    `frame-ancestors ${ancestors.length > 0 ? ancestors.join(" ") : "'self'"}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

/** A fresh nonce: 128 bits, base64, one per request. */
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
