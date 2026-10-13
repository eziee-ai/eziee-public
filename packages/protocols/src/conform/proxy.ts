import { getAddress, type Address, type Hex, type PublicClient } from "viem";

// EIP-1967 slots: bytes32(uint256(keccak256("eip1967.proxy.<implementation|admin|beacon>")) - 1).
const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
/** EIP-1167 minimal proxy runtime code: a fixed prefix, the 20-byte target, a fixed suffix. */
const EIP1167 = /^0x363d3d373d3d3d363d73[0-9a-f]{40}5af43d82803e903d91602b57fd5bf3$/;

/** `admin` is the EIP-1967 admin slot: who may upgrade a transparent proxy. A beacon proxy has no admin of its own; whoever owns the BEACON upgrades it. */
export type DetectedProxy = { type: "none" } | { type: "uups" | "clone" } | { type: "transparent"; admin: Address } | { type: "beacon"; beacon: Address };

const slotAddress = (word: Hex | undefined): Address | null => (word && /^0x0{24}[0-9a-fA-F]{40}$/.test(word) && !/^0x0+$/.test(word) ? getAddress(`0x${word.slice(26)}`) : null);

/**
 * What kind of proxy, if any, sits at an address, from the standard storage slots and the minimal-proxy bytecode.
 * Known limits: a proxy using custom slots, or a diamond, reads as "none". `code` is returned so a caller need
 * not fetch it twice; it is null when the address has no code at all.
 */
export async function detectProxy(client: Pick<PublicClient, "getCode" | "getStorageAt">, address: Address): Promise<{ code: Hex | null; proxy: DetectedProxy }> {
  const code = await client.getCode({ address });
  if (!code || code === "0x") return { code: null, proxy: { type: "none" } };
  const [implementation, admin, beacon] = await Promise.all([IMPLEMENTATION_SLOT, ADMIN_SLOT, BEACON_SLOT].map((slot) => client.getStorageAt({ address, slot: slot as Hex }).then(slotAddress)));
  const proxy: DetectedProxy = beacon ? { type: "beacon", beacon } : implementation ? (admin ? { type: "transparent", admin } : { type: "uups" }) : EIP1167.test(code.toLowerCase()) ? { type: "clone" } : { type: "none" };
  return { code, proxy };
}
