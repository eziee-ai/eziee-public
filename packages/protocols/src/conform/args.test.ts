import { describe, expect, it } from "vitest";
import { parseArgs } from "./args";

describe("conformance arguments", () => {
  it("reads a full command line", () => {
    const options = parseArgs(["registry/x/manifest.json", "--rpc", "8453=https://rpc.example/v1?key=a=b", "--mcp", "https://mcp.example/mcp", "--mcp-key-env", "X_KEY", "--samples", "s.json", "--account", "0x00000000000000000000000000000000000000aa", "--strict", "--json"]);
    expect(options).toMatchObject({ manifest: "registry/x/manifest.json", mcp: "https://mcp.example/mcp", keyEnv: "X_KEY", samples: "s.json", account: "0x00000000000000000000000000000000000000AA", strict: true, json: true });
    expect(options.rpc.get(8453)).toBe("https://rpc.example/v1?key=a=b");
  });

  it.each([
    ["a flag given no value, which would otherwise quietly skip the server checks", ["m.json", "--mcp"], /--mcp needs a value/],
    ["a flag whose value is the next flag", ["m.json", "--mcp", "--json"], /--mcp needs a value/],
    ["an RPC with no URL, which would mask the RPC the repo already knows", ["m.json", "--rpc", "5042002="], /--rpc takes/],
    ["an account that is not an address", ["m.json", "--account", "alice"], /--account must be an address/],
    ["an unknown flag", ["m.json", "--fast"], /unknown argument/],
    ["no manifest", ["--json"], /manifest path/],
  ])("refuses %s", (_name, argv, message) => {
    expect(() => parseArgs(argv)).toThrow(message);
  });
});
