"use client";

import Link from "next/link";
import { formatUsd } from "@repo/agent/pricing";
import { cn } from "@repo/ui/cn";
import { repliesLeft } from "@/lib/billing/repliesLeft";
import { useAppSession } from "@/lib/session/useAppSession";

/** Below this many replies left, the chip says so in the warning colour. */
const LOW_REPLIES = 5;

/**
 * Credit where the person types: what is left, and roughly how many replies it buys (lib/billing/repliesLeft.ts).
 * What one send needs comes from this chat's latest reply, else from the session for the default model. Opens the
 * credit page.
 */
export function CreditChip({ replyCosts, sendFloorMicrousd }: { /** What each finished reply in this chat cost, in micro-USD. */ replyCosts: readonly bigint[]; /** What this chat's latest reply said one send needs, if any has. */ sendFloorMicrousd: bigint | null }) {
  const { credit } = useAppSession();
  if (!credit) return null;
  const spendable = BigInt(credit.spendableMicrousd);
  const floor = sendFloorMicrousd ?? (credit.sendFloorMicrousd ? BigInt(credit.sendFloorMicrousd) : null);
  const left = repliesLeft({ spendableMicrousd: spendable, replyCosts, minHoldMicrousd: BigInt(credit.minHoldMicrousd ?? "0"), sendFloorMicrousd: floor });
  const empty = spendable <= 0n || left === 0;
  const warn = empty || (left !== null && left < LOW_REPLIES);
  // With credit but no known floor, there is no honest estimate: only the balance is shown.
  const estimate = empty ? " · add more to chat" : left === null ? "" : ` · about ${left} more ${left === 1 ? "reply" : "replies"}`;

  return (
    <Link
      href="/settings/credit"
      data-testid="credit-chip"
      data-tone={warn ? "warn" : undefined}
      className={cn("flex h-9 items-center whitespace-nowrap rounded-full px-3 text-[13px] text-[color:var(--m-text-secondary)] transition-colors hover:bg-[color:var(--m-surface-2)] hover:text-[color:var(--m-text-primary)]", warn && "text-[color:var(--m-warning-700)] hover:text-[color:var(--m-warning-700)] dark:text-[color:var(--m-warning-300)] dark:hover:text-[color:var(--m-warning-300)]")}
    >
      {formatUsd(spendable)} credit{estimate}
    </Link>
  );
}
