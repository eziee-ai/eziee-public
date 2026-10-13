import { describe, expect, it, vi } from "vitest";
import { rpcOverride } from "./protocolSource";

describe("rpcOverride", () => {
  it("takes an https endpoint, or plain http to this machine", () => {
    expect(rpcOverride(1, { RPC_URL_1: "https://rpc.example/v1/key" })).toBe("https://rpc.example/v1/key");
    expect(rpcOverride(1, { RPC_URL_1: "http://127.0.0.1:8545" })).toBe("http://127.0.0.1:8545/");
    expect(rpcOverride(1, {})).toBeUndefined();
  });

  it("ignores, loudly, an endpoint that would send the server's reads over plain http or that is not a URL", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(rpcOverride(1, { RPC_URL_1: "http://rpc.example" })).toBeUndefined();
    expect(rpcOverride(1, { RPC_URL_1: "rpc.example" })).toBeUndefined();
    expect(log).toHaveBeenCalledTimes(2);
    log.mockRestore();
  });
});
