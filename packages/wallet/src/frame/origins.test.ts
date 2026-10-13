import { describe, expect, it, vi } from "vitest";
import { normalizeOrigin } from "./origins";

/**
 * `normalizeOrigin` is what both origin checks compare against, so it has to
 * produce exactly the string the browser puts in `event.origin` — or every
 * message is dropped and the wallet reads as "did not answer".
 */
describe("normalizeOrigin", () => {
  it("returns the fallback for nothing", () => {
    expect(normalizeOrigin(undefined, "https://app.test")).toBe("https://app.test");
    expect(normalizeOrigin("", "https://app.test")).toBe("https://app.test");
    expect(normalizeOrigin("   ", "https://app.test")).toBe("https://app.test");
  });

  it("strips a path and a trailing slash", () => {
    expect(normalizeOrigin("https://wallet.example.com/", "x")).toBe("https://wallet.example.com");
    expect(normalizeOrigin("https://wallet.example.com/wallet-frame", "x")).toBe("https://wallet.example.com");
  });

  it("drops a default port and keeps a real one", () => {
    expect(normalizeOrigin("https://wallet.example.com:443", "x")).toBe("https://wallet.example.com");
    expect(normalizeOrigin("https://dev.example.com:3101", "x")).toBe("https://dev.example.com:3101");
  });

  it("lower-cases the host", () => {
    expect(normalizeOrigin("https://Wallet.Example.COM", "x")).toBe("https://wallet.example.com");
  });

  it("falls back on garbage rather than comparing against it", () => {
    expect(normalizeOrigin("wallet.example.com", "https://app.test")).toBe("https://app.test");
    expect(normalizeOrigin("not a url", "https://app.test")).toBe("https://app.test");
  });
});

describe("appOrigins", () => {
  it("parses a comma-separated list, normalises each entry, and drops garbage", async () => {
    vi.stubEnv("NEXT_PUBLIC_WALLET_APP_ORIGIN", " https://www.example.com/, https://example.com , not-an-origin ,https://www.example.com");
    const { appOrigins, isAllowedAppOrigin, appOrigin } = await import("./origins");
    expect(appOrigins()).toEqual(["https://www.example.com", "https://example.com"]);
    expect(isAllowedAppOrigin("https://example.com")).toBe(true);
    expect(isAllowedAppOrigin("https://evil.example")).toBe(false);
    expect(appOrigin()).toBe("https://www.example.com");
    vi.unstubAllEnvs();
  });
});
