import { appChains } from "@/lib/chains";
import { usdcRailConfig, type UsdcRailConfig } from "./usdc";

/**
 * Which ways of adding credit this deployment has switched on (spec §14.3). A rail exists only when its
 * configuration is present AND its code does: the market-priced utility-token rail is specified and not built (it
 * prices the token on a market that does not exist yet), so it is never listed, whatever is configured. The app's own
 * test tokens, at a fixed price set on /admin, are a different thing: see `tokens.ts`.
 */
export function usdcRail(): UsdcRailConfig | null {
  return usdcRailConfig(process.env, appChains.map((chain) => chain.id), (chainId) => appChains.find((chain) => chain.id === chainId)?.testnet === true);
}

export function enabledRails(): string[] {
  const rails: string[] = [];
  if (usdcRail()) rails.push("usdc");
  return rails;
}

/** A whole number from the environment, or the default. A value that is set but malformed throws with its name, not a stack trace from inside the billing math. */
function envInteger(name: string, fallback: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^[0-9]{1,12}$/.test(raw) || Number(raw) > max) throw new Error(`${name} must be a whole number from 0 to ${max}; got "${raw}"`);
  return Number(raw);
}

/**
 * The billing numbers are read when asked, not when a module loads. The chat reads them at load, so a bad value
 * stops it at once; the session reads them per request, so a bad value cannot take sign-in down with it.
 */
export function marginBps(): number {
  return envInteger("BILLING_MARGIN_BPS", 3000, 100_000);
}

/** The least any message holds, in micro-USD. */
export function minHoldMicrousd(): bigint {
  return BigInt(envInteger("BILLING_MIN_HOLD_MICROUSD", 10_000, 1_000_000_000));
}
