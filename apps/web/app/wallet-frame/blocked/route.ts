/**
 * Where the wallet host sends every path that is not the wallet frame.
 *
 * One deployment serves both hosts, so without this the wallet origin would
 * serve the whole app — every page, every route handler — and any script on
 * those pages would run on the origin that holds the key. `next.config.ts`
 * rewrites every non-frame path on the wallet host here, and `proxy.ts`
 * refuses the ones it sees first. The answer is a plain 404 with no body
 * worth reading.
 */
const notFound = () => new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });

export const GET = notFound;
export const HEAD = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
export const OPTIONS = notFound;
