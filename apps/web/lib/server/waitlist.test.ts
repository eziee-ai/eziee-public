import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getDb: vi.fn(), joinWaitlist: vi.fn() }));
vi.mock("@repo/db", () => mocks);
import { POST } from "@/app/api/waitlist/route";

let ip = 0;
function request(body: unknown, origin = "https://eziee.vercel.app") {
  return new Request("https://eziee.vercel.app/api/waitlist", {
    method: "POST", headers: { origin, "x-forwarded-for": `test-${++ip}` }, body: JSON.stringify(body),
  });
}
beforeEach(() => { vi.clearAllMocks(); mocks.getDb.mockResolvedValue({}); mocks.joinWaitlist.mockResolvedValue(undefined); });

it("saves a valid request before confirming", async () => {
  const response = await POST(request({ email: "hello@example.com" }));
  expect(response.status).toBe(200);
  expect(mocks.joinWaitlist).toHaveBeenCalledWith({}, "hello@example.com");
});
it("rejects malformed email and cross-origin submissions", async () => {
  expect((await POST(request({ email: "invalid" }))).status).toBe(400);
  expect((await POST(request({ email: "hello@example.com" }, "https://other.example"))).status).toBe(403);
  expect(mocks.joinWaitlist).not.toHaveBeenCalled();
});
it("never confirms an unsuccessful database write", async () => {
  mocks.joinWaitlist.mockRejectedValueOnce(new Error("database unavailable"));
  const response = await POST(request({ email: "hello@example.com" }));
  expect(response.status).toBe(503);
  expect(await response.json()).toHaveProperty("error");
});
it("ignores honeypot submissions", async () => {
  expect((await POST(request({ email: "bot@example.com", website: "spam" }))).status).toBe(200);
  expect(mocks.joinWaitlist).not.toHaveBeenCalled();
});
