/**
 * Guards a raw `<input type="number">` change value before it's used to
 * derive order amounts. `onKeyDown` blocking '-'/'e' only stops keystrokes --
 * it does nothing for pasted text (Ctrl+V), so a pasted negative value would
 * otherwise flow straight into limitPrice/quoteAmount/baseAmount and later
 * fail ABI-encoding a negative number into a Solidity `uint256` parameter,
 * surfacing as a confusing wallet/tx error instead of being rejected here.
 *
 * Empty string is valid (the "cleared the field" state); anything that
 * doesn't parse to a finite, non-negative number is rejected.
 */
export function isValidNonNegativeNumberInput(value: string): boolean {
  if (value === "") return true;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0;
}

/**
 * Normalise what a user typed into an amount field.
 *
 * The deposit field rendered **`018 USDC`** — on the button that spends it and
 * again in the recorded transfer. `Number("018")` is 18, so nothing was
 * miscalculated; what was wrong is that a screen about moving money showed a
 * figure no one would write down, which is exactly when a reader stops
 * trusting the other figures on it.
 *
 * Kept out of the components because three of them collect an amount — deposit,
 * withdraw, and the action dock — and each had its own inline `replace`. Two of
 * them stripped non-numerics and none of them handled a leading zero or a
 * second dot.
 *
 * Rules, in order:
 *  - anything that is not a digit or a dot is dropped, so a paste of
 *    "25 USDC" or "1,000" becomes digits rather than being rejected outright;
 *  - only the FIRST dot survives — "1.2.3" is not a number and silently
 *    truncating to "1.2" would spend a different amount than was typed;
 *  - leading zeros go, except the single one before a decimal point, so "018"
 *    is "18" and "0.5" stays "0.5".
 *
 * An empty string is returned unchanged: it is the cleared field, not a zero.
 */
export function normalizeAmountInput(value: string): string {
  const digitsAndDots = value.replace(/[^0-9.]/g, "");
  if (digitsAndDots === "") return "";

  const firstDot = digitsAndDots.indexOf(".");
  const single =
    firstDot === -1
      ? digitsAndDots
      : digitsAndDots.slice(0, firstDot + 1) + digitsAndDots.slice(firstDot + 1).replace(/\./g, "");

  // "0." and "0" are both things someone is in the middle of typing; only a run
  // of zeros in FRONT of another digit is the mistake.
  return single.replace(/^0+(?=\d)/, "");
}

