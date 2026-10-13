import { describe, expect, it } from "vitest";
import { isValidNonNegativeNumberInput, normalizeAmountInput } from "./numberInput";

describe("isValidNonNegativeNumberInput", () => {
  it("accepts the empty string (cleared field)", () => {
    expect(isValidNonNegativeNumberInput("")).toBe(true);
  });

  it("accepts ordinary non-negative numbers, including decimals", () => {
    expect(isValidNonNegativeNumberInput("0")).toBe(true);
    expect(isValidNonNegativeNumberInput("0.001")).toBe(true);
    expect(isValidNonNegativeNumberInput("3421.55512345")).toBe(true);
  });

  it("rejects negative numbers, including ones typed with a leading '-'", () => {
    // onKeyDown blocks typing '-', but paste bypasses keydown handlers entirely --
    // this is the guard that has to catch it instead.
    expect(isValidNonNegativeNumberInput("-5")).toBe(false);
    expect(isValidNonNegativeNumberInput("-0.001")).toBe(false);
  });

  it("rejects non-numeric garbage without throwing", () => {
    expect(isValidNonNegativeNumberInput("abc")).toBe(false);
    expect(isValidNonNegativeNumberInput("--5")).toBe(false);
  });

  it("rejects Infinity (e.g. pasted '1e999')", () => {
    expect(isValidNonNegativeNumberInput("1e999")).toBe(false);
  });
});

describe("normalizeAmountInput", () => {
  it("drops a leading zero run, which is the bug it exists for", () => {
    // Rendered "018 USDC" on the deposit button and in the recorded transfer.
    expect(normalizeAmountInput("018")).toBe("18");
    expect(normalizeAmountInput("000025")).toBe("25");
  });

  it("keeps the zero that belongs to a decimal", () => {
    expect(normalizeAmountInput("0.5")).toBe("0.5");
    expect(normalizeAmountInput("0.0001")).toBe("0.0001");
    // Mid-typing states are not mistakes.
    expect(normalizeAmountInput("0")).toBe("0");
    expect(normalizeAmountInput("0.")).toBe("0.");
  });

  it("keeps only the first dot", () => {
    // "1.2.3" is not a number, and truncating to "1.2" would spend an amount
    // nobody typed.
    expect(normalizeAmountInput("1.2.3")).toBe("1.23");
    expect(normalizeAmountInput("..5")).toBe(".5");
  });

  it("salvages a paste rather than rejecting it", () => {
    expect(normalizeAmountInput("25 USDC")).toBe("25");
    expect(normalizeAmountInput("1,000")).toBe("1000");
    expect(normalizeAmountInput("-5")).toBe("5");
  });

  it("returns an empty field unchanged, because cleared is not zero", () => {
    expect(normalizeAmountInput("")).toBe("");
    expect(normalizeAmountInput("abc")).toBe("");
  });
});

