import type { BrowserContext, Route } from "@playwright/test";
import { RATE_DEPLOYMENTS } from "../../../packages/protocols/src/rate/generated/deployments";
import { APP_ORIGIN } from "./ports";

/**
 * Rate's indexer gateway, answered locally.
 *
 * A swap is built from a FRESH route, asked for the moment before the wallet is
 * shown anything, and the build runs in the browser — so this suite can answer
 * that fetch without a live gateway or a funded testnet. Only `/api/swap/route`
 * is answered; any other path on those hosts comes back 404, so an unmocked call
 * fails loudly instead of quietly reaching the internet.
 */

export interface GatewayMock {
  /** Every `/api/swap/route` query string asked for, in order. */
  asked: string[];
}

export type SwapRoute =
  | { available: true; path: string[]; amountIn: number; estimatedOut: number; leftoverIn: number; priceImpactPct: number; hops: Array<{ pair: string; side: string; mktPrice: number; avgPrice: number }> }
  | { available: false; code?: string; reason?: string };

/** The gateway is a different origin, so its answer has to say the app may read it. */
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, OPTIONS" };

export async function mockRateGateway(context: BrowserContext, route: SwapRoute): Promise<GatewayMock> {
  const state: GatewayMock = { asked: [] };

  const handle = async (intercepted: Route) => {
    if (intercepted.request().method() === "OPTIONS") return intercepted.fulfill({ status: 204, headers: CORS });
    const url = new URL(intercepted.request().url());
    // The browser reaches the gateway through the app's /api/gateway/<chainId>/ route; the server, directly.
    if (!url.pathname.endsWith("/api/swap/route")) {
      return intercepted.fulfill({ status: 404, headers: CORS, contentType: "application/json", body: JSON.stringify({ error: `gatewayMock: unexpected path ${url.pathname}` }) });
    }
    state.asked.push(url.search.replace(/^\?/, ""));
    await intercepted.fulfill({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify(route) });
  };

  // Both networks, from the vendored deployment data, so no gateway host is written down here.
  for (const deployment of Object.values(RATE_DEPLOYMENTS)) await context.route(`${deployment.gatewayUrl}/**`, handle);
  await context.route(`${APP_ORIGIN}/api/gateway/**`, handle);
  return state;
}
