import { createRateLimiter } from "./rateLimit";
import { testHooksEnabled } from "./testHooks";

// An end-to-end run signs in dozens of wallets from one address in a minute. Production limits are untouched.
const scale = testHooksEnabled() ? 100 : 1;

/** Per server instance (spec §14.4). Sign-in is cheap to attempt and worth slowing; chat costs money per call. */
export const authLimiter = createRateLimiter({ limit: 20 * scale, windowMs: 60_000 });
export const chatLimiterByAddress = createRateLimiter({ limit: 30 * scale, windowMs: 60_000 });
export const chatLimiterByIp = createRateLimiter({ limit: 60 * scale, windowMs: 60_000 });
/** Builds proxied to a Verified protocol's server: each one spends that server's budget and ours. */
export const buildLimiterByAddress = createRateLimiter({ limit: 30 * scale, windowMs: 60_000 });
export const buildLimiterByIp = createRateLimiter({ limit: 60 * scale, windowMs: 60_000 });
/** Deposit checks. Each one reads a chain; a page polls while a deposit confirms, so this allows a poll every few seconds. */
export const topUpLimiterByAddress = createRateLimiter({ limit: 40 * scale, windowMs: 60_000 });
export const topUpLimiterByIp = createRateLimiter({ limit: 80 * scale, windowMs: 60_000 });
/** Funding quotes and status checks. Each one is a call to a third party on our key. */
export const fundingLimiterByAddress = createRateLimiter({ limit: 40 * scale, windowMs: 60_000 });
export const fundingLimiterByIp = createRateLimiter({ limit: 80 * scale, windowMs: 60_000 });
/** The test credit route, which only exists under the test hooks. Not scaled: nothing needs more than this. */
export const devCreditLimiter = createRateLimiter({ limit: 5, windowMs: 60_000 });
/** Rate's gateway, read through this server because it does not answer browsers on other origins. */
export const gatewayLimiterByIp = createRateLimiter({ limit: 240 * scale, windowMs: 60_000 });
/** Folder create, rename and delete. A person does a handful; this only stops a script. */
export const folderLimiterByAddress = createRateLimiter({ limit: 60 * scale, windowMs: 60_000 });
