import { getDb } from "@repo/db";
import { CHAT_TOO_LONG_MESSAGE, handleChat } from "@/lib/server/chat";
import { clientIp, problem, readJsonBody, sameOrigin } from "@/lib/server/http";
import { chatLimiterByAddress, chatLimiterByIp } from "@/lib/server/limits";
import { currentAddress } from "@/lib/server/session";
import { testHooksEnabled } from "@/lib/server/testHooks";
import { rateManifest } from "@repo/protocols/rate";

// A tool loop can run for a while; the platform default would cut a long answer off.
export const maxDuration = 120;
/**
 * The browser sends the whole chat each time, tool results included, and a chat may run to 1,000 messages. Tool
 * results are JSON and can be several kilobytes each, so a long chat passes 2 MB well before its message limit.
 * The cap exists so a body cannot be arbitrarily large; past it, the person is told to start a new chat. It sits
 * under Vercel's 4.5 MB request limit, so this route, not the platform, is what answers an oversized chat.
 */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export async function POST(request: Request) {
  if (!sameOrigin(request)) return problem(403, "FORBIDDEN", "This request did not come from the app.");
  const address = await currentAddress();
  if (!address) return problem(401, "SIGN_IN_REQUIRED", "Sign in with your wallet to chat.");

  for (const limited of [chatLimiterByAddress.take(address), chatLimiterByIp.take(clientIp(request))]) {
    if (!limited.ok) return problem(429, "RATE_LIMITED", "You are sending messages too quickly. Try again shortly.", { retryAfterSeconds: limited.retryAfterSeconds });
  }

  const read = await readJsonBody(request, MAX_BODY_BYTES);
  if (!read.ok && read.reason === "too-large") return problem(413, "CHAT_TOO_LONG", CHAT_TOO_LONG_MESSAGE);
  // Anything else unreadable goes on as nothing, which the turn refuses as not valid.
  const body = read.ok ? read.value : null;
  // End-to-end tests script the model; everything else runs for real. Imported only then, so the test
  // harness (`ai/test`) is never loaded by a server that serves people.
  const [quote, base] = rateManifest.tokens["5042002"] ?? [];
  // Monad's launch quote, for the scripted launch and ladder buy.
  const launchQuote = rateManifest.tokens["10143"]?.find((t) => t.symbol === "tUSD");
  const model = testHooksEnabled() && quote && base && launchQuote ? (await import("@/lib/server/mockModel")).mockModel({ base: base.address, quote: quote.address, launchQuote: launchQuote.address }) : undefined;
  return handleChat({ db: await getDb(), address, body, signal: request.signal, model });
}
