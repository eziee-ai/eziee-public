/**
 * How a protocol is shown: its name and mark. The mark is Rate's own icon, copied from iter-monorepo
 * apps/web/app/icon.svg, the file rate.limo serves.
 */
export interface ProtocolBrand {
  name: string;
  /** A same-origin image path, or null when the protocol has no mark: a generic icon is shown instead. */
  logo: string | null;
}

const BRANDS: Record<string, ProtocolBrand> = {
  rate: { name: "Rate", logo: "/protocols/rate.svg" },
};

export function protocolBrand(id: string): ProtocolBrand {
  return BRANDS[id] ?? { name: id.charAt(0).toUpperCase() + id.slice(1), logo: null };
}
