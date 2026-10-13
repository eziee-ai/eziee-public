"use client";

/**
 * Copy text, and say whether it worked.
 *
 * Lifted verbatim from `SwapFlow`'s `TxLink`, which is where the two rules
 * below were learned. Three other call sites still hold their own copy of this
 * (`AddressDisplay`, `DepositPanel`, and the swap card itself); they are not
 * touched here, but new callers should use this rather than adding a fifth.
 *
 * ## The fallback is not legacy cruft
 *
 * `navigator.clipboard` needs a secure context. `localhost` has one and a
 * preview served over plain http does not, so the modern API is simply absent
 * on surfaces people really use. `execCommand` is deprecated and is the only
 * thing that works there.
 *
 * ## A failed copy must SAY SO
 *
 * This used to be swallowed in an empty catch — right about not claiming a copy
 * that did not happen, wrong about saying nothing: the button looked identical
 * before and after, so a reader who pressed it could not tell it from a dead
 * control. Returning a boolean is what lets the caller tell them.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    const field = document.createElement("textarea");
    field.value = text;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.appendChild(field);
    field.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(field);
    return ok;
  } catch {
    return false;
  }
}
