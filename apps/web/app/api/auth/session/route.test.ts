import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The session is asked for on every page. It must not load the chat turn (the model SDK, the agent, the protocol
// registry), and a malformed billing setting must not take sign-in down with it.
vi.mock("@/lib/server/chat", () => {
  throw new Error("the session route must not load the chat module");
});
vi.mock("@/lib/server/session", () => ({ currentAddress: async () => "0x0000000000000000000000000000000000001001" }));
vi.mock("@/lib/server/billing/sendFloor", () => ({ defaultSendFloor: vi.fn(async () => 126_672n) }));
vi.mock("@repo/db", () => ({ getDb: async () => ({}), getAccount: async () => ({ balance: 60_000n, held: 10_000n, spendable: 50_000n, blocked: false }) }));

const { GET } = await import("./route");
const { defaultSendFloor } = await import("@/lib/server/billing/sendFloor");

let logged: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  logged = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  logged.mockRestore();
});

describe("GET /api/auth/session", () => {
  it("says what can be spent, what is held, the least a message holds, and what one send of the default model needs", async () => {
    vi.stubEnv("BILLING_MIN_HOLD_MICROUSD", "");
    const json = (await (await GET()).json()) as { credit: Record<string, unknown> };
    expect(json.credit).toEqual({ spendableMicrousd: "50000", heldMicrousd: "10000", minHoldMicrousd: "10000", sendFloorMicrousd: "126672", blocked: false });
  });

  it("leaves out what one send needs when it cannot be worked out", async () => {
    vi.mocked(defaultSendFloor).mockResolvedValueOnce(null);
    const json = (await (await GET()).json()) as { credit: Record<string, unknown> };
    expect(json.credit).not.toHaveProperty("sendFloorMicrousd");
    expect(json.credit).toMatchObject({ spendableMicrousd: "50000" });
  });

  it("still answers when a billing value is malformed, without the number it cannot read", async () => {
    vi.stubEnv("BILLING_MIN_HOLD_MICROUSD", "ten cents");
    const response = await GET();
    expect(response.status).toBe(200);
    const json = (await response.json()) as { credit: Record<string, unknown> };
    expect(json.credit).toMatchObject({ spendableMicrousd: "50000" });
    expect(json.credit).not.toHaveProperty("minHoldMicrousd");
  });
});
