/**
 * What to SAY when a wallet action does not go through.
 *
 * ## Why this is a module and not two lines in a catch
 *
 * The withdrawal's confirm step used one regex — `/reject|denied|cancel/i` over
 * the error's message — to decide whether a failure was the user's own
 * decision, and reported everything else through a toast. Three things were
 * wrong with that, and together they produced a button that appeared to do
 * nothing:
 *
 *  - **The message is the wrong place to look.** mera wraps anything that is
 *    not already a `MeraError` as `PASSKEY_OPERATION_FAILED` and REPLACES the
 *    message, so the real reason survives only on `cause`. A wrapper's text is
 *    what the regex saw.
 *  - **A toast can be invisible.** Every `<Toaster>` in this app is
 *    bottom-right, which is exactly where a browser extension's panel sits. The
 *    one surface guaranteed to be looked at is the card the button is in.
 *  - **A loose regex swallows real failures.** Any message containing the
 *    letters "cancel" — an RPC that reports a cancelled request, say — was
 *    silently treated as the user changing their mind.
 *
 * ## It is shared because the failures are not per-feature
 *
 * A locked passkey, a declined prompt and a rate-limited RPC reach the withdraw
 * card and the swap flow's approval step by exactly the same paths, through the
 * same connector. This started life as `lib/transfer/withdrawError`, serving
 * one of them; the swap's approve step was swallowing its errors in a bare
 * `.catch()` at the same time, and a second copy of these rules is how one of
 * them stops matching the wallet.
 *
 * ## `NotAllowedError` is NOT counted as a decision
 *
 * WebAuthn raises it both when someone dismisses the prompt AND when the
 * browser refused to show one — a passkey ceremony needs a user activation, and
 * a click's activation is spent by the time several awaited RPC round trips
 * have gone by. Those are opposite problems with one error name, so the copy
 * names both possibilities rather than picking the flattering one.
 */

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "");
}

/**
 * The error and everything it wraps, outermost first.
 *
 * viem nests: a `TransactionExecutionError` carries the `HttpRequestError` that
 * actually knows the status code, and only the innermost one holds `status`.
 * Reading the top-level message alone finds a summary of a summary.
 */
function chain(error: unknown, depth = 6): unknown[] {
  const out: unknown[] = [];
  let current = error;
  while (current && depth-- > 0) {
    out.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return out;
}

/**
 * Did the RPC refuse us for asking too often?
 *
 * Checked across the whole cause chain and by STATUS as well as by wording,
 * because the number is the reliable part — `429` appears as a field on viem's
 * `HttpRequestError` long before any human-readable phrase does.
 */
function isRateLimited(error: unknown): boolean {
  return chain(error).some((level) => {
    if ((level as { status?: unknown })?.status === 429) return true;
    const text = `${messageOf(level)} ${String((level as { details?: unknown })?.details ?? "")}`;
    return /\b429\b|too many requests|rate ?limit/i.test(text);
  });
}

/** The message a wrapper is hiding, if there is one. */
function causeMessage(error: unknown): string | null {
  const cause = (error as { cause?: unknown })?.cause;
  if (!cause) return null;
  const text = messageOf(cause).trim();
  return text.length > 0 ? text : null;
}

/**
 * A user's own "no". Reported as nothing at all — never as an error.
 *
 * EIP-1193's 4001 and the wallet phrasings that omit it. Deliberately NOT
 * `NotAllowedError`: see the note above.
 */
export function isWalletDecision(error: unknown): boolean {
  if ((error as { code?: unknown })?.code === 4001) return true;
  return /user rejected|user denied|rejected the request/i.test(messageOf(error));
}

/**
 * One sentence for the card, or null when there is nothing to report.
 *
 * Null means the user declined; every other outcome gets words, because a
 * primary action that does nothing and says nothing is indistinguishable from a
 * broken button.
 */
export function describeWalletFailure(
  error: unknown,
  context: { gasSymbol?: string } = {},
): string | null {
  if (isWalletDecision(error)) return null;

  const message = messageOf(error);

  /*
   * NOT ENOUGH TO PAY THE FEE — the commonest failure on a testnet, and the one
   * whose raw text is the least usable.
   *
   * viem reports it as a paragraph explaining that "the total cost (gas * gas
   * fee + value) of executing this transaction exceeds the balance of the
   * account", followed by the calldata, both addresses, the ABI signature, a
   * documentation link and two unlabelled wei figures. All of it is true and
   * none of it tells someone what to do.
   *
   * The wei figures are deliberately NOT quoted back. They arrive with no
   * decimals and no symbol, and Arc's gas asset is USDC viewed at 18 decimals
   * while its ERC-20 is 6 — the 10^12 mistake this repo keeps writing down.
   * Printing `have 100000000000000` invites the reader to compare it against a
   * balance shown in another unit entirely.
   */
  if (/insufficient funds|exceeds the balance of the account/i.test(message)) {
    const asset = context.gasSymbol ? ` ${context.gasSymbol}` : "";
    return `Not enough${asset} in this wallet to cover the network fee. Add a little more and try again — nothing was sent.`;
  }

  /*
   * A RATE-LIMITED RPC, which on a public testnet endpoint is the ordinary
   * failure rather than an exotic one.
   *
   * `lib/providers.tsx` gives every chain a bare `http()` transport, so the
   * browser talks straight to the chain's public RPC — `rpc.testnet.arc.network`
   * for Arc — and viem has already retried before this is reached. Saying so is
   * the difference between "the app is broken" and "wait a moment": nothing was
   * spent, and the same click will work later.
   *
   * It must say the funds did not move. A withdrawal that reports an error the
   * user cannot interpret is one they will try again from somewhere else, and
   * double-sending is the expensive mistake on this screen.
   */
  if (isRateLimited(error)) {
    return "The network's public RPC is refusing requests right now (429, too many requests). Nothing was sent — wait a moment and confirm again.";
  }

  // meraConnector's own words when the session has ended. The key lives only in
  // memory for the life of a session, so a reload closes it BY DESIGN — this is
  // the most likely failure here and the least self-explanatory.
  if (/passkey wallet is locked|passkey session has expired/i.test(message) || (error as { code?: unknown })?.code === 4100) {
    // Location-neutral on purpose. This sentence reaches two surfaces: the
    // withdraw panel, which renders a Sign in button beside it, and the swap
    // flow, which shows it in a toast with no control at all. Naming a place
    // ("at the top of the page") was wrong for the first — the button is right
    // there — and unreliable for the second, since AppShell's chrome is hidden
    // below 1200px. Naming the ACTION is true everywhere.
    return "Your passkey session has ended — reloading the page closes it. Sign in again, then confirm.";
  }

  if (/not ?allowed|notallowederror/i.test(message) || (error as { name?: unknown })?.name === "NotAllowedError") {
    return "Your passkey did not confirm. Either the prompt was dismissed, or it never appeared — try once more, and sign in again if nothing opens.";
  }

  // A wrapper whose message says nothing: prefer what it is wrapping.
  const cause = causeMessage(error);
  if (/passkey (creation|operation) failed/i.test(message) && cause) {
    return readableLine(cause) ?? FALLBACK;
  }

  return readableLine(message) ?? FALLBACK;
}

const FALLBACK = "The wallet could not complete that. Try again in a moment.";

/**
 * ONE readable line out of an error that may be a page of machinery.
 *
 * viem's messages are multi-line reports: a sentence, then `Request Arguments`,
 * the calldata, the contract call, an ABI signature, a docs URL and a version.
 * Returning the whole thing rendered a wall of hex inside the approval card —
 * which is worse than saying nothing, because it buries the one sentence that
 * was useful and looks like the app broke rather than the transaction.
 *
 * So: drop the lines that are machinery, take the first that is prose, and cap
 * it. A reader gets a sentence; the full object is still in the console for
 * whoever wants it.
 */
const NOISE = /^\s*(request arguments|contract call|docs|version|details|address|function|args|sender|from|to|data|value|gas|maxfeepergas|maxpriorityfeepergas|nonce)\s*:/i;

export function readableLine(text: string, limit = 180): string | null {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || NOISE.test(line)) continue;
    // A line carrying a long hex run is calldata or an address, never prose.
    if (/0x[0-9a-fA-F]{12,}/.test(line)) continue;
    // A bare run of digits long enough to be wei is not a sentence either.
    if (/\b\d{12,}\b/.test(line)) continue;
    return line.length > limit ? `${line.slice(0, limit - 1).trimEnd()}…` : line;
  }
  return null;
}

/**
 * Why the confirm button cannot act yet.
 *
 * The handler used to `return` on exactly these two conditions, silently, which
 * is the same screen as a dead button.
 */

/**
 * Is this the failure a fresh sign-in fixes?
 *
 * Worth answering separately from the sentence, because it is the one case with
 * a one-click remedy — and leaving the user to find the header button is how a
 * recoverable state reads as a broken screen.
 */
export function walletFailureNeedsSignIn(error: unknown): boolean {
  // 4100 is EIP-1193's "unauthorized", and the code the wallet frame answers
  // with when its stored session has expired — see lib/wallet/frame/protocol.
  if ((error as { code?: unknown })?.code === 4100) return true;
  return /passkey wallet is locked|passkey session has expired/i.test(messageOf(error));
}
