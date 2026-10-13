import { describe, expect, it } from "vitest";
import { currentProtocolId, renameLegacyToolParts } from "./legacyRate";

describe("names saved before Iter became Rate", () => {
  it("maps the old protocol id and leaves every other id alone", () => {
    expect(currentProtocolId("iter")).toBe("rate");
    expect(currentProtocolId("rate")).toBe("rate");
    expect(currentProtocolId("auto")).toBe("auto");
    expect(currentProtocolId("iterative")).toBe("iterative");
  });

  it("renames old tool parts and dynamic tools, never text", () => {
    const old = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "use iter_swap" }] },
      { id: "a1", role: "assistant", parts: [{ type: "tool-iter_swap", toolCallId: "c1", state: "output-available", input: {}, output: {} }, { type: "dynamic-tool", toolName: "iter_quote", toolCallId: "c2" }, { type: "tool-openDeposit", toolCallId: "c3" }] },
    ];
    expect(renameLegacyToolParts(old)).toEqual([
      { id: "u1", role: "user", parts: [{ type: "text", text: "use iter_swap" }] },
      { id: "a1", role: "assistant", parts: [{ type: "tool-rate_swap", toolCallId: "c1", state: "output-available", input: {}, output: {} }, { type: "dynamic-tool", toolName: "rate_quote", toolCallId: "c2" }, { type: "tool-openDeposit", toolCallId: "c3" }] },
    ]);
  });
});
