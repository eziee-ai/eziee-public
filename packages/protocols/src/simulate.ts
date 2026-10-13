import type { Address } from "viem";
import type { AdapterContext, SimResult, TxRequest } from "./types";

/**
 * eth_call each transaction from the user's address. A call that fails only
 * because an approval EARLIER IN THE SAME BATCH has not been mined yet is
 * `deferred`, not failed: the caller re-simulates it after sending the approval.
 */
export async function simulate(txs: TxRequest[], ctx: AdapterContext & { account: Address }): Promise<SimResult> {
  const deferred: number[] = [];
  let approvalSeen = false;
  for (const [index, tx] of txs.entries()) {
    const isApproval = tx.data.startsWith("0x095ea7b3");
    try {
      await ctx.client.call({ account: ctx.account, to: tx.to, data: tx.data, value: tx.value });
    } catch (error) {
      if (approvalSeen && !isApproval) deferred.push(index);
      else return { ok: false, reason: error instanceof Error ? error.message.split("\n")[0]!.slice(0, 240) : "the transaction would revert" };
    }
    if (isApproval) approvalSeen = true;
  }
  return deferred.length > 0 ? { ok: true, deferred } : { ok: true };
}
