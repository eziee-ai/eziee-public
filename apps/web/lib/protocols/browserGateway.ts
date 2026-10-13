import { RATE_DEPLOYMENTS, type FetchLike } from "@repo/protocols/rate";

/**
 * Rate's gateway as the browser reaches it: through this app's own /api/gateway route, since the gateway does not
 * answer other origins. A URL on any other host is fetched as given.
 */
export const browserGatewayFetch: FetchLike = (input, init) => {
  for (const deployment of Object.values(RATE_DEPLOYMENTS)) {
    if (input.startsWith(`${deployment.gatewayUrl}/`)) return fetch(`/api/gateway/${deployment.chainId}/${input.slice(deployment.gatewayUrl.length + 1)}`, init);
  }
  return fetch(input, init);
};
