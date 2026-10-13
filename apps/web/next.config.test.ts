import { describe, expect, it } from "vitest";
import config from "./next.config";

describe("next.config headers()", () => {
  // A nonce-less `Content-Security-Policy` header from headers() is copied onto
  // the request and shadows the per-request nonce Next reads to tag its scripts.
  // It fails invisibly (the page renders, scripts just lose the nonce), so pin it.
  it("never sets a Content-Security-Policy header", async () => {
    const rules = (await config.headers?.()) ?? [];
    const keys = rules.flatMap((rule) => rule.headers.map((h) => h.key.toLowerCase()));
    expect(keys).not.toContain("content-security-policy");
  });

  it("keeps the clickjacking header on app paths and off the wallet frame", async () => {
    const rules = (await config.headers?.()) ?? [];
    const rule = rules.find((r) => r.headers.some((h) => h.key === "X-Frame-Options"));
    expect(rule?.headers).toContainEqual({ key: "X-Frame-Options", value: "SAMEORIGIN" });
    expect(rule?.source).toContain("(?!wallet-frame");
  });
});
