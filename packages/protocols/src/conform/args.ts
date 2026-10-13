import { getAddress, isAddress } from "viem";

export const USAGE = "usage: protocols:conform <manifest.json> [--rpc <chainId>=<url>]... [--mcp <url>] [--mcp-key-env <NAME>] [--samples <file>] [--account <address>] [--strict] [--json]";

/** Every flag that takes a value must be given one. A missing value is an error here, never an empty string that quietly turns a check off. */
export function parseArgs(argv: string[]) {
  const options = { manifest: "", rpc: new Map<number, string>(), mcp: "", keyEnv: "", samples: "", account: "0x0000000000000000000000000000000000001001", json: false, strict: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = () => {
      const next = argv[++i];
      if (next === undefined || next.startsWith("--")) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === "--rpc") {
      const [id, ...rest] = value().split("=");
      const url = rest.join("=");
      if (!/^[1-9][0-9]*$/.test(id ?? "") || !/^https?:\/\//.test(url)) throw new Error("--rpc takes <chainId>=<url>, for example --rpc 8453=https://…");
      options.rpc.set(Number(id), url);
    } else if (arg === "--mcp") options.mcp = value();
    else if (arg === "--mcp-key-env") options.keyEnv = value();
    else if (arg === "--samples") options.samples = value();
    else if (arg === "--account") {
      const account = value();
      if (!isAddress(account, { strict: false })) throw new Error("--account must be an address");
      options.account = getAddress(account);
    } else if (arg === "--json") options.json = true;
    else if (arg === "--strict") options.strict = true;
    else if (!arg.startsWith("--") && !options.manifest) options.manifest = arg;
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!options.manifest) throw new Error("a manifest path is needed");
  return options;
}
