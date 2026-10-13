import { getDb, joinWaitlist } from "@repo/db";
import { z } from "zod";
import { createRateLimiter } from "@/lib/server/rateLimit";

export const runtime = "nodejs";
const limiter = createRateLimiter({ limit: 5, windowMs: 60_000 });
const input = z.object({ email: z.string().trim().max(254).email(), website: z.string().max(200).optional() });
const json = (body: object, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return json({ error: "Please submit from the eziee website." }, 403);
  const key = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (!limiter.take(key).ok) return json({ error: "Too many requests. Please try again in a minute." }, 429);
  let data;
  try {
    const body = await request.text();
    if (body.length > 2048) return json({ error: "Request is too large." }, 413);
    data = input.safeParse(JSON.parse(body));
  } catch {
    return json({ error: "Please enter a valid email address." }, 400);
  }
  if (!data.success) return json({ error: "Please enter a valid email address." }, 400);
  if (data.data.website) return json({ ok: true });
  try {
    await joinWaitlist(await getDb(), data.data.email);
    // Identical responses keep membership private and make retries safe.
    return json({ ok: true });
  } catch {
    return json({ error: "We couldn’t save your request. Please try again shortly." }, 503);
  }
}
