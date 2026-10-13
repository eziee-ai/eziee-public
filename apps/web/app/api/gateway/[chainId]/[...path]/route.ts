import { RATE_DEPLOYMENTS } from "@repo/protocols/rate";
import { clientIp, problem } from "@/lib/server/http";
import { gatewayLimiterByIp } from "@/lib/server/limits";

/**
 * Rate's indexer gateway, read through this server. The gateway sends no CORS headers, so a browser on this origin
 * cannot read it directly (Rate's own app proxies it the same way). Only GET, only the vendored gateway of a chain
 * this build serves, only the read paths the adapter uses, and the answer is capped: this is not an open proxy.
 * What comes back is still untrusted data; the adapter validates every field as before.
 */
const ADDRESS = "0x[0-9a-fA-F]{40}";
/** Exactly the reads the adapter makes (packages/protocols/src/rate/reads.ts), each with the query keys it sends. */
const READS: Array<{ path: RegExp; query: readonly string[] }> = [
  { path: /^api\/swap\/route$/, query: ["network", "tokenIn", "tokenOut", "amountIn"] },
  { path: /^api\/pairs\/\d{1,3}\/\d{1,4}$/, query: [] },
  { path: new RegExp(`^api/orderbook/blocks/${ADDRESS}/${ADDRESS}/0/\\d{1,2}/false$`), query: [] },
  { path: new RegExp(`^api/orders/${ADDRESS}/\\d{1,3}/\\d{1,4}$`), query: [] },
  { path: new RegExp(`^api/liquidity/positions/${ADDRESS}$`), query: [] },
];
const SEGMENT = /^[A-Za-z0-9._-]{1,100}$/;
const MAX_BYTES = 2_000_000;
const notARead = () => problem(404, "NOT_FOUND", "Not a gateway read this app makes.");
const TIMEOUT_MS = 10_000;

export async function GET(request: Request, { params }: { params: Promise<{ chainId: string; path: string[] }> }) {
  const limited = gatewayLimiterByIp.take(clientIp(request));
  if (!limited.ok) return problem(429, "RATE_LIMITED", "Too many market reads. Try again shortly.", { retryAfterSeconds: limited.retryAfterSeconds });

  const { chainId, path } = await params;
  const deployment = Object.values(RATE_DEPLOYMENTS).find((d) => String(d.chainId) === chainId);
  // Each segment as DECODED must be plain: no slash, dot-segment, percent or control character can survive into the
  // upstream path, so the path checked below is the path requested.
  if (!deployment || !path.every((part) => SEGMENT.test(part) && part !== "." && part !== "..")) return notARead();
  const joined = path.join("/");
  const read = READS.find((r) => r.path.test(joined));
  if (!read) return notARead();
  const target = new URL(`${deployment.gatewayUrl}/${path.map(encodeURIComponent).join("/")}`);
  // Only the keys this read sends, each once and short: nothing else the gateway might honour gets through.
  const asked = new URL(request.url).searchParams;
  for (const key of read.query) {
    const value = asked.get(key);
    if (value !== null && value.length <= 100) target.searchParams.set(key, value);
  }
  if (target.origin !== new URL(deployment.gatewayUrl).origin || target.pathname !== `/${joined}`) return notARead();

  // No redirects: the origin checked above is the only one this server will ever ask.
  const upstream = await fetch(target, { redirect: "error", headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" }).catch(() => null);
  if (!upstream) return problem(502, "GATEWAY_UNREACHABLE", "Rate's gateway did not answer.");
  const body = await readCapped(upstream);
  if (!body) return problem(502, "GATEWAY_TOO_LARGE", "Rate's gateway answered with more than this app accepts.");
  return new Response(body, { status: upstream.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

/** The body, or null as soon as it passes the cap: an oversized answer is never fully read into memory. */
async function readCapped(response: Response): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BYTES) return null;
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(new ArrayBuffer(0));
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(new ArrayBuffer(received));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
