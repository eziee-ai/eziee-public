import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

async function load(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return (await import("./proxy")).default;
}

function req(url: string, host: string) {
  return new NextRequest(url, { headers: { host } });
}

afterEach(() => {
  delete process.env.NEXT_PUBLIC_WALLET_ORIGIN;
  delete process.env.NEXT_PUBLIC_WALLET_APP_ORIGIN;
});

describe("proxy", () => {
  it("serves the frame with an enforced strict CSP when no wallet origin is configured", async () => {
    const proxy = await load({ NEXT_PUBLIC_WALLET_ORIGIN: undefined });
    const res = proxy(req("http://localhost:3000/wallet-frame", "localhost:3000"));
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("refuses the frame on the app host when a wallet origin is configured", async () => {
    const proxy = await load({ NEXT_PUBLIC_WALLET_ORIGIN: "https://wallet.example.com" });
    const res = proxy(req("https://app.example.com/wallet-frame", "app.example.com"));
    expect(res.status).toBe(404);
  });

  it("refuses every non-frame path on the wallet host", async () => {
    const proxy = await load({ NEXT_PUBLIC_WALLET_ORIGIN: "https://wallet.example.com" });
    const res = proxy(req("https://wallet.example.com/", "wallet.example.com"));
    expect(res.status).toBe(404);
  });

  it("limits frame-ancestors to the configured app origins", async () => {
    const proxy = await load({
      NEXT_PUBLIC_WALLET_ORIGIN: "https://wallet.example.com",
      NEXT_PUBLIC_WALLET_APP_ORIGIN: "https://app.example.com",
    });
    const res = proxy(req("https://wallet.example.com/wallet-frame/confirm", "wallet.example.com"));
    expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors https://app.example.com");
  });

  it("allows the app to frame the wallet origin and connect to chain RPCs", async () => {
    const proxy = await load({ NEXT_PUBLIC_WALLET_ORIGIN: "https://wallet.example.com" });
    const res = proxy(req("https://app.example.com/", "app.example.com"));
    const csp = res.headers.get("Content-Security-Policy-Report-Only") ?? "";
    expect(csp).toContain("frame-src 'self' https://wallet.example.com");
    expect(csp).toContain("https://rpc.testnet.arc.network");
  });
});
