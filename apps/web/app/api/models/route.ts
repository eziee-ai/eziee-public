import { NextResponse } from "next/server";
import { availableModels, MODEL_ALLOWLIST } from "@repo/agent";
import { VERIFIED_MANIFESTS } from "@repo/protocols/verified";
import { protocolSource } from "@/lib/server/protocolSource";
import { protocolBrand } from "@/lib/protocols/brand";

/**
 * What the prompt input's two pickers offer (spec D12, §7.3): the models the
 * gateway serves right now from our allowlist, and the protocols this build ships.
 */
export async function GET() {
  // If the gateway cannot be asked, the picker still shows the allowlist, marked unavailable, rather than an empty control.
  const live = await availableModels().catch(() => null);
  const models = MODEL_ALLOWLIST.map((m) => ({ id: m.id, label: m.label, available: live ? live.some((l) => l.id === m.id) : false, isDefault: live?.find((l) => l.id === m.id)?.isDefault ?? false }));
  // First-party protocols are described here; a Verified one is described by its reviewed manifest, never by its server.
  const FIRST_PARTY: Record<string, { name: string; capabilities: string[] }> = { rate: { name: protocolBrand("rate").name, capabilities: ["Swap", "Limit orders", "Liquidity"] } };
  const protocols = (await protocolSource.adapters()).map((adapter) => {
    const manifest = VERIFIED_MANIFESTS.find((m) => m.id === adapter.id);
    const known = FIRST_PARTY[adapter.id];
    return {
      id: adapter.id,
      name: known?.name ?? manifest?.name ?? adapter.id,
      tier: known ? "first-party" : "verified",
      chains: adapter.chains.map((c) => c.id),
      capabilities: known?.capabilities ?? Object.keys(adapter.actions).map((action) => manifest?.actions[action]?.title ?? action),
    };
  });
  return NextResponse.json({ models, protocols, gatewayReachable: live !== null }, { headers: { "cache-control": "public, max-age=60" } });
}
