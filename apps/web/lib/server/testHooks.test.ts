import { afterEach, describe, expect, it, vi } from "vitest";
import { testHooksEnabled } from "./testHooks";

afterEach(() => vi.unstubAllEnvs());

describe("testHooksEnabled", () => {
  it("is off unless asked for", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("E2E_TEST_HOOKS", "");
    expect(testHooksEnabled()).toBe(false);
  });

  it("is on in development when asked for", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("E2E_TEST_HOOKS", "1");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("DATABASE_URL", "");
    expect(testHooksEnabled()).toBe(true);
  });

  it.each([
    ["a hosted deployment, whatever its build mode", "VERCEL", "1"],
    ["a hosted preview", "VERCEL_ENV", "preview"],
    ["a server on a real database", "DATABASE_URL", "postgres://example"],
  ])("stays off on %s", (_name, variable, value) => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("E2E_TEST_HOOKS", "1");
    vi.stubEnv(variable, value);
    expect(testHooksEnabled()).toBe(false);
  });

  it("stays off in production even when the variable is set", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("E2E_TEST_HOOKS", "1");
    expect(testHooksEnabled()).toBe(false);
  });
});

describe("the test credit route", () => {
  it("does not exist in production: 404 before anything else is looked at", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("E2E_TEST_HOOKS", "1");
    const { POST } = await import("@/app/api/dev/credit/route");
    const response = await POST(new Request("http://localhost/api/dev/credit", { method: "POST", headers: { origin: "http://localhost", host: "localhost" } }));
    expect(response.status).toBe(404);
  });
});

describe("freeCreditEnabled", () => {
  const local = () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("DATABASE_URL", "");
  };

  it("is off unless asked for", async () => {
    local();
    vi.stubEnv("DEV_FREE_CREDIT", "");
    const { freeCreditEnabled } = await import("./testHooks");
    expect(freeCreditEnabled()).toBe(false);
  });

  it("is on locally when asked for, and does not switch on the test hooks", async () => {
    local();
    vi.stubEnv("DEV_FREE_CREDIT", "1");
    vi.stubEnv("E2E_TEST_HOOKS", "");
    const { freeCreditEnabled } = await import("./testHooks");
    expect(freeCreditEnabled()).toBe(true);
    expect(testHooksEnabled()).toBe(false);
  });

  it.each([
    ["a production build", "NODE_ENV", "production"],
    ["a hosted deployment", "VERCEL", "1"],
    ["a hosted preview", "VERCEL_ENV", "preview"],
    ["a server on a real database", "DATABASE_URL", "postgres://example"],
  ])("stays off on %s", async (_name, variable, value) => {
    local();
    vi.stubEnv("DEV_FREE_CREDIT", "1");
    vi.stubEnv(variable, value);
    const { freeCreditEnabled } = await import("./testHooks");
    expect(freeCreditEnabled()).toBe(false);
  });
});
