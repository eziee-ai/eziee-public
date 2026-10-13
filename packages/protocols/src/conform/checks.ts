import { erc20Abi, type Address, type PublicClient } from "viem";
import { ProtocolError } from "../errors";
import type { Manifest } from "../manifest";
import { acceptBuild, actionProblem } from "../mcp/adapter";
import type { McpCaller } from "../mcp/caller";
import { detectProxy } from "./proxy";

/**
 * Conformance checks (guideline §7). Each returns findings; none throws for a failed check, so one bad address
 * does not hide the ten after it.
 *
 * `note` is something a reviewer should look at that the app does not depend on; it never fails a run.
 * `not-run` is a first-class result. A check that could not be made (no RPC for a chain, no sample intent for an
 * action) is reported as exactly that, never as a pass.
 */
export interface Finding {
  check: string;
  status: "pass" | "fail" | "not-run" | "note";
  detail: string;
  /** A `not-run` this tool can never run; it is done by hand in review. */
  manual?: true;
}

const pass = (check: string, detail = ""): Finding => ({ check, status: "pass", detail });
const fail = (check: string, detail: string): Finding => ({ check, status: "fail", detail });
const reason = (error: unknown) => (error instanceof Error ? error.message.split("\n")[0]!.slice(0, 200) : "unknown error");

/** The manifest's claims about one chain, checked against that chain: code at every address, proxy types, token metadata. */
export async function checkChain(manifest: Manifest, chainId: number, client: PublicClient): Promise<Finding[]> {
  const findings: Finding[] = [];

  for (const [key, contract] of Object.entries(manifest.contracts[String(chainId)] ?? {})) {
    try {
      const { code, proxy } = await detectProxy(client, contract.address);
      findings.push(code ? pass(`contract ${key} has code`, contract.address) : fail(`contract ${key} has code`, `${contract.address} has no code on chain ${chainId}: calls to it succeed and do nothing, and tokens sent to it are gone`));
      if (!code) continue;
      findings.push(
        proxy.type === contract.proxy.type
          ? pass(`contract ${key} proxy type`, proxy.type)
          : fail(`contract ${key} proxy type`, `declared "${contract.proxy.type}", found "${proxy.type}". A proxy's code can change after review, so the manifest must say so`),
      );
      // Who can change the code matters as much as that it can change (guideline §2). A reviewer weighs the declared
      // admin, so it has to be the one the chain names.
      const declaredAdmin = "admin" in contract.proxy ? contract.proxy.admin : undefined;
      if (proxy.type === "transparent") {
        if (!declaredAdmin) findings.push(fail(`contract ${key} proxy admin`, `a transparent proxy must declare its admin; the chain says ${proxy.admin}`));
        else findings.push(declaredAdmin.toLowerCase() === proxy.admin.toLowerCase() ? pass(`contract ${key} proxy admin`, proxy.admin) : fail(`contract ${key} proxy admin`, `declared ${declaredAdmin}, the chain says ${proxy.admin}`));
      } else if (declaredAdmin) {
        findings.push({ check: `contract ${key} proxy admin`, status: "note", detail: `an admin is declared, and this proxy type keeps none in the standard slot${proxy.type === "beacon" ? `; its beacon is ${proxy.beacon}, and whoever owns that upgrades it` : ""}. Review by hand` });
      }
    } catch (error) {
      findings.push(fail(`contract ${key} has code`, `could not be read: ${reason(error)}`));
    }
  }

  for (const token of manifest.tokens[String(chainId)] ?? []) {
    try {
      const [symbol, decimals] = await Promise.all([
        client.readContract({ address: token.address, abi: erc20Abi, functionName: "symbol" }),
        client.readContract({ address: token.address, abi: erc20Abi, functionName: "decimals" }),
      ]);
      findings.push(symbol === token.symbol ? pass(`token ${token.symbol} symbol`) : fail(`token ${token.symbol} symbol`, `${token.address} calls itself "${String(symbol).slice(0, 40)}"`));
      findings.push(Number(decimals) === token.decimals ? pass(`token ${token.symbol} decimals`) : fail(`token ${token.symbol} decimals`, `declared ${token.decimals}, the token says ${Number(decimals)}: every amount would be wrong by a power of ten`));
    } catch (error) {
      findings.push(fail(`token ${token.symbol} symbol`, `${token.address} does not answer as an ERC-20: ${reason(error)}`));
    }
  }
  return findings;
}

export interface ServerSamples {
  [action: string]: { chainId: number; intent: Record<string, unknown> };
}

/**
 * The protocol's MCP server, held to the rule the app enforces at run time (`acceptBuild`): for each sample
 * intent, what `build` returns must decode from the manifest alone as that action, paying `account`, with exact
 * approvals to a router.
 */
export async function checkServer(manifest: Manifest, caller: McpCaller, options: { samples: ServerSamples; account: Address; nowMs: number }): Promise<Finding[]> {
  const findings: Finding[] = [];
  let names: string[];
  let tools: Awaited<ReturnType<McpCaller["listTools"]>>;
  try {
    tools = await caller.listTools();
    names = tools.map((tool) => tool.name);
    findings.push(pass("server lists its tools", `${names.length} tools`));
  } catch (error) {
    return [fail("server lists its tools", reason(error))];
  }
  for (const name of new Set(names.filter((n, index) => names.indexOf(n) !== index))) findings.push(fail(`tool ${name}`, "listed more than once; which one answers is then undefined"));

  for (const action of Object.keys(manifest.actions)) {
    const tool = `${manifest.id}.build.${action}`;
    const listed = tools.find((candidate) => candidate.name === tool);
    findings.push(listed ? pass(`server builds ${action}`) : fail(`server builds ${action}`, `the manifest declares "${action}" and the server lists no "${tool}"`));
    if (listed) {
      // The same test the app applies before it offers an action. A failure here means the app will NOT offer it.
      const problem = actionProblem(manifest, action, ((listed.inputSchema as { properties?: { intent?: unknown } } | undefined)?.properties?.intent ?? undefined) as Record<string, unknown> | undefined);
      findings.push(problem ? fail(`intent of ${action}`, problem) : pass(`intent of ${action}`));
    }
  }
  // Stated in guideline §5.1 and not something the app depends on, so their absence is a note, not a failure.
  for (const tool of tools) {
    const [, kind] = tool.name.split(".");
    if (kind === "read" && tool.annotations?.readOnlyHint !== true) findings.push({ check: `tool ${tool.name}`, status: "note", detail: "a read should declare annotations.readOnlyHint: true" });
    if ((kind === "read" || kind === "build") && tool.outputSchema === undefined) findings.push({ check: `tool ${tool.name}`, status: "note", detail: "declares no outputSchema" });
  }
  for (const name of names) {
    const [id, kind, short] = name.split(".");
    if (id !== manifest.id || (kind !== "read" && kind !== "build") || !short) findings.push({ check: `tool ${name}`, status: "note", detail: "not named <id>.read.<name> or <id>.build.<action>; the app ignores it" });
    else if (kind === "build" && !Object.hasOwn(manifest.actions, short)) findings.push({ check: `tool ${name}`, status: "note", detail: "builds an action the manifest does not declare; the app never offers it" });
  }

  for (const action of Object.keys(manifest.actions)) {
    const check = `build ${action} round-trips`;
    const sample = options.samples[action];
    if (!sample) {
      findings.push({ check, status: "not-run", detail: "no sample intent was given for this action (samples.json)" });
      continue;
    }
    if (!names.includes(`${manifest.id}.build.${action}`)) continue;
    try {
      const result = await caller.callTool(`${manifest.id}.build.${action}`, { chainId: sample.chainId, account: options.account, intent: sample.intent }, { timeoutMs: 3000 });
      if (result.isError) {
        findings.push(fail(check, `the server answered the sample intent with an error: ${JSON.stringify(result.structuredContent ?? null).slice(0, 200)}`));
        continue;
      }
      const txs = acceptBuild(manifest, action, result.structuredContent, { chainId: sample.chainId, account: options.account, nowMs: options.nowMs });
      findings.push(pass(check, `${txs.length} transaction(s), approvals exact, recipient is the account`));
    } catch (error) {
      findings.push(fail(check, error instanceof ProtocolError ? error.message : reason(error)));
    }
  }
  return findings;
}

/** `strict`: a check that could have been made and was not (an unreachable RPC, no server given) also fails the run. Checks this tool can never make (`manual`) do not. */
export function summarize(findings: Finding[], options: { strict?: boolean } = {}): { ok: boolean; pass: number; fail: number; notRun: number; note: number } {
  const count = (status: Finding["status"]) => findings.filter((finding) => finding.status === status).length;
  const avoidable = findings.filter((finding) => finding.status === "not-run" && !finding.manual).length;
  return { ok: count("fail") === 0 && !(options.strict && avoidable > 0), pass: count("pass"), fail: count("fail"), notRun: count("not-run"), note: count("note") };
}
