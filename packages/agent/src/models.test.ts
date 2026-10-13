import { beforeEach, describe, expect, it, vi } from "vitest";
import { availableModels, resetModelCacheForTests, resolveModel } from "./models";

const listing = (ids: Record<string, unknown>) => async () => ({ ok: true, json: async () => ({ data: Object.entries(ids).map(([id, pricing]) => ({ id, pricing })) }) });
const PRICE = { input: "0.000003", output: "0.000015" };

beforeEach(() => resetModelCacheForTests());

describe("availableModels", () => {
  it("offers the allowlist intersected with what the gateway serves, default first", async () => {
    const models = await availableModels({ fetch: listing({ "moonshotai/kimi-k3": PRICE, "openai/gpt-5.5": PRICE, "anthropic/claude-sonnet-5": PRICE, "openai/gpt-something": PRICE }) });
    expect(models.map((m) => [m.id, m.isDefault])).toEqual([["openai/gpt-5.5", true], ["moonshotai/kimi-k3", false], ["anthropic/claude-sonnet-5", false]]);
  });

  it("drops a model the gateway lists without a usable price, rather than serving it unmetered", async () => {
    const models = await availableModels({ fetch: listing({ "moonshotai/kimi-k3": { input: "0.000003" }, "moonshotai/kimi-k3-fast": PRICE }) });
    expect(models.map((m) => m.id)).toEqual(["moonshotai/kimi-k3-fast"]);
  });

  it("caches for ten minutes, then asks again", async () => {
    const fetch = vi.fn(listing({ "moonshotai/kimi-k3": PRICE }));
    await availableModels({ fetch, now: 0 });
    await availableModels({ fetch, now: 9 * 60_000 });
    expect(fetch).toHaveBeenCalledTimes(1);
    await availableModels({ fetch, now: 11 * 60_000 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("never resolves an unknown or unlisted model to a different one", async () => {
    const fetch = listing({ "moonshotai/kimi-k3": PRICE });
    expect(await resolveModel("openai/gpt-something", { fetch })).toBeNull();
    expect((await resolveModel("moonshotai/kimi-k3", { fetch }))?.label).toBe("Kimi K3");
  });

  it("during an outage asks once, then fails fast for half a minute instead of timing out on every request", async () => {
    const down = vi.fn(async () => ({ ok: false, json: async () => ({}) }));
    await expect(availableModels({ fetch: down, now: 0 })).rejects.toThrow();
    await expect(availableModels({ fetch: down, now: 10_000 })).rejects.toThrow();
    expect(down).toHaveBeenCalledTimes(1);
    await expect(availableModels({ fetch: down, now: 31_000 })).rejects.toThrow();
    expect(down).toHaveBeenCalledTimes(2);
  });

  it("serves the last good listing through an outage, for up to an hour, and recovers when the gateway does", async () => {
    await availableModels({ fetch: listing({ "moonshotai/kimi-k3": PRICE }), now: 0 });
    const down = async () => Promise.reject(new Error("network"));
    expect((await availableModels({ fetch: down, now: 20 * 60_000 })).map((m) => m.id)).toEqual(["moonshotai/kimi-k3"]);
    await expect(availableModels({ fetch: down, now: 61 * 60_000 })).rejects.toThrow();
    expect((await availableModels({ fetch: listing({ "moonshotai/kimi-k3-fast": PRICE }), now: 62 * 60_000 })).map((m) => m.id)).toEqual(["moonshotai/kimi-k3-fast"]);
  });

  it("reads each model's context window from the listing, and assumes 128k when it is missing or not a whole number", async () => {
    const withWindows = async () => ({ ok: true, json: async () => ({ data: [
      { id: "moonshotai/kimi-k3", pricing: PRICE, context_window: 1000000 },
      { id: "moonshotai/kimi-k3-fast", pricing: PRICE },
      { id: "anthropic/claude-sonnet-5", pricing: PRICE, context_window: "big" },
    ] }) });
    const models = await availableModels({ fetch: withWindows });
    expect(models.map((m) => [m.id, m.contextWindow])).toEqual([["moonshotai/kimi-k3", 1000000], ["moonshotai/kimi-k3-fast", 128000], ["anthropic/claude-sonnet-5", 128000]]);
  });

  it("fails loudly when the gateway cannot be asked", async () => {
    await expect(availableModels({ fetch: async () => ({ ok: false, json: async () => ({}) }) })).rejects.toThrow();
  });
});
