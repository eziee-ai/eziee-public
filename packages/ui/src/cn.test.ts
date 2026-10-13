import { describe, expect, it } from "vitest";
import { cn } from "./cn";

describe("cn", () => {
  it("joins truthy class names", () => {
    // eslint-disable-next-line no-constant-binary-expression -- deliberately falsy input to prove cn() drops it
    expect(cn("a", false && "b", "c")).toBe("a c");
  });

  it("lets a later tailwind utility override an earlier conflicting one", () => {
    expect(cn("p-2", "p-4")).toBe("p-4");
  });
});
