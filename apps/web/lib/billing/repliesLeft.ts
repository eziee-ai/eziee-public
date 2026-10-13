/**
 * Roughly how many more replies the spendable credit buys.
 *
 * A message is sent only when the account can hold one worst-case call, the SEND FLOOR, which is far above what a
 * reply usually costs. So below the floor the answer is 0, however cheap replies have been. At or above it, one
 * reply is certain, and the rest is counted at this chat's average reply cost (before any reply, at the minimum
 * hold). Integers only, always rounded down, so it never promises a reply the credit cannot pay for.
 *
 * Null when the floor is not known: then there is no honest estimate, and only the balance is shown.
 */
export function repliesLeft(input: { spendableMicrousd: bigint; replyCosts: readonly bigint[]; minHoldMicrousd: bigint; sendFloorMicrousd: bigint | null }): number | null {
  const { spendableMicrousd: spendable, replyCosts, minHoldMicrousd: minHold, sendFloorMicrousd: floor } = input;
  if (floor === null) return null;
  if (spendable <= 0n || spendable < floor) return 0;
  const rest = spendable - floor;
  const spent = replyCosts.reduce((sum, cost) => sum + (cost > 0n ? cost : 0n), 0n);
  // rest ÷ (spent ÷ n), written so the average is never rounded before it divides.
  const more = spent > 0n ? (rest * BigInt(replyCosts.length)) / spent : minHold > 0n ? rest / minHold : 0n;
  return 1 + Number(more);
}
