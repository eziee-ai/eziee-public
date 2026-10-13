import { describe, expect, it } from "vitest";
import { repliesLeft } from "./repliesLeft";

const at = (spendableMicrousd: bigint, replyCosts: bigint[], sendFloorMicrousd: bigint | null, minHoldMicrousd = 10_000n) => repliesLeft({ spendableMicrousd, replyCosts, minHoldMicrousd, sendFloorMicrousd });

describe("repliesLeft", () => {
  it("is 0 below what one send needs, however cheap the replies have been", () => {
    // $0.05 left, a send needs about $0.09 held, and replies cost $0.006: every send would be refused.
    expect(at(50_000n, [6_240n], 90_000n)).toBe(0);
    expect(at(0n, [], 90_000n)).toBe(0);
  });

  it("at the floor, is exactly one", () => {
    expect(at(90_000n, [6_240n], 90_000n)).toBe(1);
  });

  it("above the floor, is one plus what the rest buys at the chat's average cost, rounded down", () => {
    expect(at(993_760n, [6_240n], 123_162n)).toBe(1 + 139);
    // The average of 3 and 4 is 3.5. Rounding it down first would promise 3 more from 10; the truth is 2.
    expect(at(110n, [3n, 4n], 100n)).toBe(1 + 2);
  });

  it("with no reply yet, counts the rest in minimum holds", () => {
    expect(at(1_000_000n, [], 126_672n)).toBe(1 + 87);
    expect(at(1_000_000n, [0n], 126_672n)).toBe(1 + 87);
    expect(at(1_000_000n, [], 126_672n, 0n)).toBe(1);
  });

  it("is null when the floor is not known, so only the balance is shown", () => {
    expect(at(1_000_000n, [6_240n], null)).toBeNull();
  });
});
