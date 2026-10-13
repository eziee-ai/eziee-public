import { afterEach, describe, expect, it, vi } from "vitest";
import { clientIp, readJsonBody, readJsonCapped, sameOrigin } from "./http";

afterEach(() => vi.unstubAllEnvs());
const post = (headers: Record<string, string>, body?: string) => new Request("http://internal/api/x", { method: "POST", headers, body });

describe("sameOrigin", () => {
  it("with the app's origins configured, accepts exactly those and ignores what the request says its host is", () => {
    vi.stubEnv("NEXT_PUBLIC_WALLET_APP_ORIGIN", "https://app.example, https://www.app.example");
    expect(sameOrigin(post({ origin: "https://app.example", host: "anything" }))).toBe(true);
    expect(sameOrigin(post({ origin: "https://www.app.example" }))).toBe(true);
    // A forwarded-host header is the caller's own claim; with a configured list it proves nothing.
    expect(sameOrigin(post({ origin: "https://evil.example", host: "evil.example", "x-forwarded-host": "evil.example" }))).toBe(false);
  });

  it("with nothing configured (local development), compares the Origin with the Host and never with a forwarded host", () => {
    vi.stubEnv("NEXT_PUBLIC_WALLET_APP_ORIGIN", "");
    expect(sameOrigin(post({ origin: "http://localhost:3000", host: "localhost:3000" }))).toBe(true);
    expect(sameOrigin(post({ origin: "https://evil.example", host: "localhost:3000", "x-forwarded-host": "evil.example" }))).toBe(false);
  });

  it.each([["no Origin at all", {}], ["an Origin that is not a URL", { origin: "null", host: "localhost" }]])("refuses %s", (_name, headers) => {
    vi.stubEnv("NEXT_PUBLIC_WALLET_APP_ORIGIN", "");
    expect(sameOrigin(post(headers as Record<string, string>))).toBe(false);
  });
});

describe("clientIp", () => {
  it("prefers the platform's own header, which a caller cannot set", () => {
    expect(clientIp(post({ "x-vercel-forwarded-for": "203.0.113.9", "x-forwarded-for": "1.1.1.1" }))).toBe("203.0.113.9");
  });

  it("otherwise takes the LAST forwarded hop, the one our own proxy added, not the first, which the caller writes", () => {
    expect(clientIp(post({ "x-forwarded-for": "6.6.6.6, 198.51.100.4" }))).toBe("198.51.100.4");
    expect(clientIp(post({}))).toBe("unknown");
  });
});

describe("readJsonCapped", () => {
  it("reads a JSON body within the cap", async () => {
    expect(await readJsonCapped(post({ "content-type": "application/json" }, '{"a":1}'), 100)).toEqual({ a: 1 });
  });

  it("is null for a body past the cap, whether or not it declared its length, and for a body that is not JSON", async () => {
    expect(await readJsonCapped(post({ "content-length": "5000" }, '{"a":1}'), 100)).toBeNull();
    expect(await readJsonCapped(post({}, JSON.stringify({ a: "x".repeat(500) })), 100)).toBeNull();
    expect(await readJsonCapped(post({}, "not json"), 100)).toBeNull();
  });
});

describe("readJsonBody", () => {
  it("tells a body that is too large apart from one that is not JSON", async () => {
    expect(await readJsonBody(post({}, '{"a":1}'), 100)).toEqual({ ok: true, value: { a: 1 } });
    expect(await readJsonBody(post({ "content-length": "5000" }, '{"a":1}'), 100)).toEqual({ ok: false, reason: "too-large" });
    expect(await readJsonBody(post({}, JSON.stringify({ a: "x".repeat(500) })), 100)).toEqual({ ok: false, reason: "too-large" });
    expect(await readJsonBody(post({}, "not json"), 100)).toEqual({ ok: false, reason: "invalid" });
    expect(await readJsonBody(post({}), 100)).toEqual({ ok: false, reason: "invalid" });
  });
});
