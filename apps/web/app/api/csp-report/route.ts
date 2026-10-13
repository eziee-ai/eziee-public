// Browsers POST CSP violation reports here. Phase 1 acknowledges them; a later
// plan forwards them to logging.
export async function POST(): Promise<Response> {
  return new Response(null, { status: 204 });
}
