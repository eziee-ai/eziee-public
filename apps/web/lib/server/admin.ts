import { getAddress, isAddress, type Address } from "viem";
import { testHooksEnabled } from "./testHooks";

/**
 * Who may open /admin: the wallet addresses in `ADMIN_ADDRESSES`, comma separated. Nobody when it is unset. An
 * admin is an ordinary signed-in wallet; the list is the only thing that makes it one.
 */
export function adminAddresses(env: Record<string, string | undefined> = process.env): Set<string> {
  return new Set(
    (env.ADMIN_ADDRESSES ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => isAddress(entry))
      .map((entry) => getAddress(entry)),
  );
}

export function isAdmin(address: Address | null, env: Record<string, string | undefined> = process.env): boolean {
  if (address === null) return false;
  // End-to-end tests sign in with a passkey made on the spot, so its address cannot be listed in advance.
  if (env.E2E_ADMIN_ANY === "1" && testHooksEnabled()) return true;
  return adminAddresses(env).has(getAddress(address));
}
