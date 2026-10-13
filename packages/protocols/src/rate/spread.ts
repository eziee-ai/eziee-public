import type { Address, PublicClient } from "viem";
import { BandPoolABI } from "./abis";

/**
 * How far from the market price a pool may quote, per side, as the pool itself holds it (`BandPool.pairLimit`):
 * the creator's slippage cap capped by the engine's market spread, in the pool's DENOM units. Every band is a
 * FRACTION of this limit (`tolerance = spreadFrac × limit ÷ DENOM`), so no band is ever beyond it, and a deposit
 * is never refused for reach. Zero means the pair has no spread set: its bands quote nothing until it has one.
 */
export async function pairLimits(client: PublicClient, pool: Address): Promise<{ buy: number; sell: number }> {
  const [buy, sell] = await Promise.all([
    client.readContract({ address: pool, abi: BandPoolABI, functionName: "pairLimit", args: [true] }),
    client.readContract({ address: pool, abi: BandPoolABI, functionName: "pairLimit", args: [false] }),
  ]);
  return { buy: Number(buy), sell: Number(sell) };
}
