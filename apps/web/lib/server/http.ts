import { NextResponse } from "next/server";
import { appOrigins } from "@repo/wallet/frame/origins";

/** A JSON error with a machine-readable code. Bodies never carry stack traces or upstream text. */
export function problem(status: number, code: string, message: string, extra: Record<string, unknown> = {}): NextResponse {
  return NextResponse.json({ error: { code, message }, ...extra }, { status, headers: { "cache-control": "no-store" } });
}

/**
 * State-changing requests must come from this site. Cookies are SameSite=Lax,
 * which already stops cross-site POSTs in current browsers; checking `Origin`
 * closes what Lax leaves (older browsers, same-site sibling origins).
 *
 * "This site" is the configured list of app origins when there is one (every
 * production deployment sets it, see .env.example). Only with nothing
 * configured, which is local development, is the Origin compared with the
 * request's own Host. `X-Forwarded-Host` is never consulted: it is a header
 * the caller can write.
 */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const configured = appOrigins();
  if (configured.length > 0) return configured.includes(origin);
  const host = request.headers.get("host");
  try {
    return host !== null && new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * The caller's address, for rate limiting only. The platform's own header first, because a caller cannot set
 * it. Failing that the LAST entry of X-Forwarded-For: each proxy appends the peer it saw, so the last one was
 * written by our own edge, while the first is whatever the caller sent.
 *
 * All of these are only as good as the proxy in front: served with NO proxy, a caller can set any of them and
 * dodge the per-address-of-origin limit. They feed rate limits only, never a decision about who someone is, and
 * the limits that matter most are also kept per signed-in wallet address.
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",").map((hop) => hop.trim()).filter(Boolean) ?? [];
  return request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip")?.trim() || forwarded[forwarded.length - 1] || "unknown";
}

/**
 * A JSON body, read with a byte cap. Route handlers have no default limit, and `request.json()` parses whatever
 * arrives before anything can refuse it. A body past the cap is told apart from one that is unreadable or not
 * JSON, so a route can answer each in words that fit.
 */
export async function readJsonBody(request: Request, maxBytes: number): Promise<{ ok: true; value: unknown } | { ok: false; reason: "too-large" | "invalid" }> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, reason: "too-large" };
  const reader = request.body?.getReader();
  if (!reader) return { ok: false, reason: "invalid" };
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, reason: "too-large" };
      }
      chunks.push(value);
    }
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

/** A JSON body, read with a byte cap. Null for a body that is too large, unreadable, or not JSON. */
export async function readJsonCapped(request: Request, maxBytes: number): Promise<unknown> {
  const read = await readJsonBody(request, maxBytes);
  return read.ok ? read.value : null;
}
