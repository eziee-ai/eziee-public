import { BRAND } from "@repo/ui/brand";
/**
 * Withdraw-specific copy. The failure sentences themselves live in
 * `lib/wallet/walletFailure` — a locked passkey and a rate-limited RPC are not
 * a property of withdrawing, and the swap flow's approval step hits both.
 *
 * Re-exported under the names this file already used so its callers and tests
 * are unchanged by the move.
 */
export {
  isWalletDecision as isWithdrawDecision,
  describeWalletFailure as describeWithdrawFailure,
  walletFailureNeedsSignIn as withdrawNeedsSignIn,
} from "@repo/wallet/walletFailure";

export function describeWithdrawBlock(opts: {
  hasChain: boolean;
  hasAmount: boolean;
  hasAccount: boolean;
}): string | null {
  if (!opts.hasAccount) {
    // No location named: WithdrawPanel now raises its Sign in button for this
    // case (it previously cleared `signInFixes` and rendered the sentence
    // alone), so the control is beside the words.
    return `No ${BRAND} account is signed in, so there is nothing to send from.`;
  }
  if (!opts.hasChain) return "This withdrawal has no network yet. Go back and choose the asset again.";
  if (!opts.hasAmount) return "Enter an amount to withdraw.";
  return null;
}
