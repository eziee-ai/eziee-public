import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server/session", () => ({ currentAddress: async () => "0x0000000000000000000000000000000000001001" }));
vi.mock("@repo/db", async (importOriginal) => ({ ...(await importOriginal<typeof import("@repo/db")>()), getDb: async () => ({}) }));
vi.mock("@/lib/server/chat", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/server/chat")>()), handleChat: vi.fn(async () => new Response("handled")) }));

const { POST } = await import("./route");
const { handleChat } = await import("@/lib/server/chat");

const MB = 1024 * 1024;
const request = (body: string, headers: Record<string, string> = {}) => new Request("http://localhost:3000/api/chat", { method: "POST", headers: { origin: "http://localhost:3000", host: "localhost:3000", "content-type": "application/json", ...headers }, body });
/** A chat request whose one message is `bytes` long: what a long chat with tool output looks like on the wire. */
const chatOf = (bytes: number) => JSON.stringify({ model: "moonshotai/kimi-k3", protocol: "auto", chainId: 5042002, messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "x".repeat(bytes) }] }] });

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_WALLET_APP_ORIGIN", "");
  vi.mocked(handleChat).mockClear();
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/chat", () => {
  it("takes a long chat of several megabytes to the turn", async () => {
    const response = await POST(request(chatOf(3 * MB)));
    expect(await response.text()).toBe("handled");
    expect(vi.mocked(handleChat).mock.calls[0]![0].body).toMatchObject({ chainId: 5042002 });
  });

  it("answers a chat too large to read with 413 and words the person can act on, before the turn runs", async () => {
    for (const response of [await POST(request(chatOf(5 * MB))), await POST(request("{}", { "content-length": String(5 * MB) }))]) {
      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({ error: { code: "CHAT_TOO_LONG", message: expect.stringContaining("Start a new chat") } });
    }
    expect(handleChat).not.toHaveBeenCalled();
  });

  it("hands a body that is not JSON to the turn as nothing, which refuses it as not valid", async () => {
    await POST(request("not json"));
    expect(vi.mocked(handleChat).mock.calls[0]![0].body).toBeNull();
  });
});
