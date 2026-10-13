/**
 * Conformance for a protocol that wants to join (guideline §7).
 *
 *   pnpm protocols:conform <manifest.json> [--rpc <chainId>=<url>]... [--mcp <url>] [--mcp-key-env <NAME>]
 *                          [--samples <samples.json>] [--account <address>] [--strict] [--json]
 *
 * Checks the manifest against the chains it names, and, with --mcp, the protocol's server against the very rule
 * the app enforces at run time. Exits 1 if anything FAILED. What it could not check is listed as "not run",
 * never as a pass: read that list before trusting a green result. With --strict (for CI) a check that COULD have
 * run and did not, an unreachable RPC or no --mcp, fails the run too.
 *
 * The API key is read from the environment variable named by --mcp-key-env, so it never appears in a command
 * line or a shell history.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, getAddress, http, type Address, type PublicClient } from "viem";
import { parseArgs, USAGE } from "../src/conform/args";
import { checkChain, checkServer, summarize, type Finding, type ServerSamples } from "../src/conform/checks";
import { RATE_DEPLOYMENTS } from "../src/rate/generated/deployments";
import { parseManifest } from "../src/manifest";
import { createHttpMcpCaller } from "../src/mcp/caller";

// pnpm runs a filtered script from the package folder; paths the person typed are relative to where THEY were.
const fromCaller = (path: string) => resolve(process.env.INIT_CWD ?? process.cwd(), path);

let options: ReturnType<typeof parseArgs>;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
  process.exit(2);
}
const findings: Finding[] = [];

/** The one way out: every path, a manifest that does not parse included, ends in the same report, so `--json` is always JSON. */
function finish(label: string): void {
  const summary = summarize(findings, { strict: options.strict });
  if (options.json) {
    console.log(JSON.stringify({ manifest: label, strict: options.strict, summary, findings }, null, 2));
  } else {
    const mark = { pass: "pass ", fail: "FAIL ", "not-run": "-----", note: "note " } as const;
    for (const finding of findings) console.log(`${mark[finding.status]} ${finding.check}${finding.detail ? `\n      ${finding.detail}` : ""}`);
    console.log(`\n${label}: ${summary.pass} passed, ${summary.fail} failed, ${summary.notRun} not run, ${summary.note} note(s)${options.strict && !summary.ok && summary.fail === 0 ? " (strict: a check that could have run did not)" : ""}`);
  }
  // Not process.exit(): stdout to a pipe is asynchronous, and exiting now can cut a report short.
  process.exitCode = summary.ok ? 0 : 1;
}

let manifest: ReturnType<typeof parseManifest> | undefined;
try {
  manifest = parseManifest(JSON.parse(readFileSync(fromCaller(options.manifest), "utf8")));
  findings.push({ check: "manifest parses", status: "pass", detail: `${manifest.id} ${manifest.version}, ${Object.keys(manifest.actions).length} action(s), chains ${manifest.chains.join(", ")}` });
} catch (error) {
  findings.push({ check: "manifest parses", status: "fail", detail: error instanceof Error ? error.message : String(error) });
}

if (!manifest) {
  finish(options.manifest);
} else {
  await run(manifest);
  finish(`${manifest.id} ${manifest.version}`);
}

async function run(manifest: ReturnType<typeof parseManifest>): Promise<void> {
  // RPCs this repo already knows, so a first-party manifest needs no flags. Anything else must be given.
  const knownRpc = new Map(Object.values(RATE_DEPLOYMENTS).map((chain) => [chain.chainId as number, chain.rpcUrl as string]));
  for (const chainId of manifest.chains) {
    const url = options.rpc.get(chainId) ?? knownRpc.get(chainId);
    if (!url) {
      findings.push({ check: `chain ${chainId}`, status: "not-run", detail: `no RPC for this chain; pass --rpc ${chainId}=<url>` });
      continue;
    }
    const client = createPublicClient({ transport: http(url, { timeout: 15_000, retryCount: 2 }) }) as PublicClient;
    try {
      const actual = await client.getChainId();
      if (actual !== chainId) {
        findings.push({ check: `chain ${chainId}`, status: "fail", detail: `the RPC given for chain ${chainId} answers as chain ${actual}` });
        continue;
      }
    } catch (error) {
      findings.push({ check: `chain ${chainId}`, status: "not-run", detail: `its RPC could not be reached: ${error instanceof Error ? error.message.split("\n")[0] : "unknown"}` });
      continue;
    }
    findings.push(...(await checkChain(manifest, chainId, client)).map((finding) => ({ ...finding, check: `[${chainId}] ${finding.check}` })));
  }

  if (options.mcp) {
    const samples = options.samples ? (JSON.parse(readFileSync(fromCaller(options.samples), "utf8")) as ServerSamples) : {};
    const apiKey = options.keyEnv ? process.env[options.keyEnv] : undefined;
    if (options.keyEnv && !apiKey) findings.push({ check: "server key", status: "fail", detail: `--mcp-key-env ${options.keyEnv} is not set in the environment` });
    const caller = createHttpMcpCaller({ url: options.mcp, apiKey, allowInsecure: /^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(options.mcp) });
    findings.push(...(await checkServer(manifest, caller, { samples, account: getAddress(options.account) as Address, nowMs: Date.now() })));
  } else {
    findings.push({ check: "protocol server", status: "not-run", detail: "no --mcp <url> was given, so no build was exercised" });
  }

  // Guideline §4a asks for two more things this command does not do. Said here, every time, so green never means more than it does.
  findings.push({ check: "signatures match verified source", status: "not-run", manual: true, detail: "compare each manifest `abi` with the contract's verified source on its explorer, by hand, in review" });
  findings.push({ check: "simulated asset movements equal the decoded spend", status: "not-run", manual: true, detail: "needs a forked chain with funded state; do this in review for every spending action" });
}
