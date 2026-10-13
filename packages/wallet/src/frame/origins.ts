/**
 * Which origin holds the key, and which origin may ask it to sign.
 *
 * ## Two origins, two variables
 *
 * `NEXT_PUBLIC_WALLET_ORIGIN` — read by the APP: where the wallet frame is
 * served, e.g. `https://wallet.example.com`. The app embeds `<origin>/wallet-frame`
 * and posts to it.
 *
 * `NEXT_PUBLIC_WALLET_APP_ORIGIN` — read by the FRAME: the one origin whose
 * messages it answers, e.g. `https://example.com`. Every other sender is ignored.
 *
 * Both are `NEXT_PUBLIC_` because both are decided in the browser, and both
 * are baked at BUILD time — the same trap `ADMIN_SERVICE_URL` carries, so a
 * change needs a rebuild, not a restart. One deployment serves both hosts (see
 * `proxy.ts`), which is why the same build must know both values.
 *
 * ## Unset means same-origin, and same-origin means NO isolation
 *
 * With neither set, the frame is `<own origin>/wallet-frame`. Everything still
 * works — the protocol, the policy, the stored session — but the frame shares
 * localStorage and IndexedDB with the app, so script on the app can read what
 * the frame stored. That is the local-development shape, so `localhost` needs
 * no second host. `isIsolated()` reports which shape is running, and the
 * connector logs once in production when it finds the degraded one: a wallet
 * that quietly ships without its boundary is the failure this file exists to
 * make visible.
 *
 * ## The frame does not need to be a subdomain of the app
 *
 * The passkey ceremony runs on the APP origin (see `lib/wallet/mera.ts`), so
 * the rpId is still the app's hostname and nothing about WebAuthn constrains
 * where the frame lives. `wallet.example.com` reads well; any origin this
 * deployment answers on would work.
 */

/**
 * Parse an origin out of a configured value, or fall back.
 *
 * `new URL(...).origin` is the normaliser: it strips a path, a trailing slash
 * and a default port, and lower-cases the host — so a value pasted with any of
 * those still compares equal to `event.origin`, which the browser always
 * reports in that canonical form. A value that does not parse, or parses to
 * the literal `"null"` origin, takes the fallback: comparing an origin check
 * against garbage would fail closed, which is safe, and also fail silently,
 * which is not.
 */
export function normalizeOrigin(raw: string | undefined | null, fallback: string): string {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  try {
    const origin = new URL(trimmed).origin;
    return origin === "null" ? fallback : origin;
  } catch {
    return fallback;
  }
}

function ownOrigin(): string {
  return typeof window === "undefined" ? "" : window.location.origin;
}

/** Where the wallet frame is served. Read by the app. */
export function walletOrigin(): string {
  return normalizeOrigin(process.env.NEXT_PUBLIC_WALLET_ORIGIN, ownOrigin());
}

/**
 * The origins the frame answers. Read by the frame.
 *
 * A comma-separated list, because a site can legitimately have more than one
 * host that renders pages — `www.example.com` and the apex today, where the apex
 * answers a 308 to www on every path (checked 2026-09-18) and so never
 * renders anything. Listing it anyway costs nothing and means a future change
 * to which host is canonical cannot silently break every wallet connect. An
 * entry that does not parse is dropped, never widened to a fallback.
 */
export function appOrigins(): string[] {
  const raw = process.env.NEXT_PUBLIC_WALLET_APP_ORIGIN?.trim();
  if (!raw) return [ownOrigin()].filter((o) => o !== "");
  const parsed = raw
    .split(",")
    .map((entry) => normalizeOrigin(entry, ""))
    .filter((o) => o !== "");
  return Array.from(new Set(parsed));
}

/** Is this `event.origin` one the frame answers? */
export function isAllowedAppOrigin(origin: string): boolean {
  return appOrigins().includes(origin);
}

/** The first allowed app origin, for callers that need exactly one. */
export function appOrigin(): string {
  return appOrigins()[0] ?? ownOrigin();
}

/** Is the frame on a different origin from the document asking? */
export function isIsolated(): boolean {
  const own = ownOrigin();
  return own !== "" && walletOrigin() !== own;
}

/** The host (with port) the wallet frame is served from, for `proxy.ts`'s host check. Null when unconfigured. */
export function walletFrameHost(): string | null {
  const raw = process.env.NEXT_PUBLIC_WALLET_ORIGIN?.trim();
  if (!raw) return null;
  try {
    return new URL(raw).host || null;
  } catch {
    return null;
  }
}

/** The path the hidden frame is served at, on the wallet origin. */
export const FRAME_PATH = "/wallet-frame";
/** The path the visible confirm frame is served at. */
export const CONFIRM_PATH = "/wallet-frame/confirm";
