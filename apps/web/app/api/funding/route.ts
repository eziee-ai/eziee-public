import { NextResponse } from "next/server";
import { appChains } from "@/lib/chains";
import { fundingRoute } from "@/lib/server/funding";

/** Which app networks can be funded from, or withdrawn to, another chain. The interface shows those sections only for these. */
export function GET() {
  return NextResponse.json({ route: fundingRoute.id, chains: appChains.filter((chain) => fundingRoute.supportsDestination(chain.id)).map((chain) => chain.id) }, { headers: { "cache-control": "public, max-age=300" } });
}
