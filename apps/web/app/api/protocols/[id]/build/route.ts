import { clientIp, problem, readJsonCapped, sameOrigin } from "@/lib/server/http";
import { buildLimiterByAddress, buildLimiterByIp } from "@/lib/server/limits";
import { handleBuild } from "@/lib/server/protocols";
import { clientFor, protocolSource } from "@/lib/server/protocolSource";
import { currentAddress } from "@/lib/server/session";

const MAX_BODY_BYTES = 64 * 1024;

/** The browser's way to a Verified protocol's `build` (see `handleBuild`). Signed-in, same-origin, rate limited. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!sameOrigin(request)) return problem(403, "FORBIDDEN", "This request did not come from the app.");
  const address = await currentAddress();
  if (!address) return problem(401, "SIGN_IN_REQUIRED", "Sign in with your wallet first.");
  for (const limited of [buildLimiterByAddress.take(address), buildLimiterByIp.take(clientIp(request))]) {
    if (!limited.ok) return problem(429, "RATE_LIMITED", "Too many requests. Try again shortly.", { retryAfterSeconds: limited.retryAfterSeconds });
  }
  return handleBuild({ source: protocolSource, protocolId: (await params).id, address, body: await readJsonCapped(request, MAX_BODY_BYTES), clientFor });
}
