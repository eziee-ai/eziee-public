/**
 * Vendors Rate's deployment facts into this package. Run by hand when Rate redeploys:
 *
 *   pnpm --filter @repo/protocols vendor:rate
 *
 * WHY A SCRIPT: no address in this repo is typed by hand (spec §6.1). Every
 * address below is copied from iter-monorepo's deployments.json, checked for
 * code on its chain, and written with the commit it came from. Token symbol,
 * name and decimals are read ONCHAIN, not from Rate's token list, so the
 * numbers are the chain's own and nothing but addresses is taken from that
 * GPL-licensed file.
 *
 * ABIs are copied byte-for-byte (they are generated from forge artifacts in
 * the source repo). Rate's contracts are BUSL-1.1: only ABIs and addresses are
 * vendored, never contract source.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, erc20Abi, getAddress, http, type Address } from "viem";
import { detectProxy } from "../src/conform/proxy";

const RATE_REPO = process.env.RATE_REPO ?? process.env.ITER_REPO ?? "/Users/hyungsukkang/iter-cx/iter-monorepo";
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHAIN_IDS = [5042002, 11155931, 10143] as const;
const SOURCE_URL = "https://github.com/iter-cx/iter-monorepo/blob/main/packages/deployments/deployments.json";

/**
 * Pinned HERE, independently of the checkout being vendored. If the RPC came from the same
 * deployments.json as the addresses, a tampered file could name its own lying RPC and pass
 * every check. These match apps/web/lib/chains.ts; changing one is a reviewed edit to this file.
 */
const PINNED_RPC: Record<number, string> = {
  5042002: "https://rpc.testnet.arc.network",
  11155931: "https://testnet.riselabs.xyz",
  10143: "https://testnet-rpc.monad.xyz",
};

/** The only gateway host accepted per chain. A scraped URL on any other host stops the run. */
const PINNED_GATEWAY_HOST: Record<number, string> = {
  5042002: "gateway-api-arc.up.railway.app",
  11155931: "gateway-api-rise.up.railway.app",
  10143: "gateway-api-monad.up.railway.app",
};

/** ABI files to copy, and the export each one carries. */
const ABIS: ReadonlyArray<[file: string, exportName: string]> = [
  ["bandSwapRouter.ts", "BandSwapRouterABI"],
  ["matchingEngine.ts", "MatchingEngineABI"],
  ["bandPositionManager.ts", "BandPositionManagerABI"],
  ["bandPoolFactory.ts", "BandPoolFactoryABI"],
  ["bandPool.ts", "BandPoolABI"],
  ["assetGenerator.ts", "AssetGeneratorABI"],
  ["ladderBuyer.ts", "LadderBuyerABI"],
  ["orderbookFactory.ts", "OrderbookFactoryABI"],
];

/** Which vendored contracts may be approved as a token spender. */
const ROLES: Record<string, "router" | "factory" | "other"> = {
  // "router" means: a contract a user may approve as a token spender for this protocol's actions.
  swapRouter: "router",
  // Limit orders escrow the offered token in the engine, so the engine is the spender there.
  matchingEngine: "router",
  // Adding liquidity: the position manager pulls both tokens from the depositor, then funds the pool itself.
  positionManager: "router",
  // Launching: the generator pulls the dev buy (and on Tempo the fee) in the quote token.
  assetGenerator: "router",
  // A launch coin still on its ladder trades through LadderBuyer, which pulls what is spent.
  ladderBuyer: "router",
  poolFactory: "factory",
  bandPoolFactory: "factory",
  orderbookFactory: "factory",
};

/**
 * Deployment entries that are NOT protocol contracts a user calls, so they stay out of the manifest:
 * - weth: a TOKEN (and on Arc it is the USDC ERC-20 itself). Registered as a contract, its
 *   transfers and approvals would read as protocol calls; the registry refuses that outright.
 * - poolFactory: an alias of bandPoolFactory at the same address.
 * - poolImplementation: the clone target; nobody calls it directly.
 * - batchExecutor: EIP-7702 batching, which this app does not support.
 */
const MANIFEST_EXCLUDE = new Set(["weth", "poolFactory", "poolImplementation", "batchExecutor"]);

interface SourceChain {
  name: string;
  chainId: number;
  rpcUrls: string[];
  blockExplorerUrl: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  contracts: Record<string, { address: string; startBlock: number }>;
}

async function main() {
  const commit = execFileSync("git", ["-C", RATE_REPO, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  const deployments = JSON.parse(readFileSync(join(RATE_REPO, "packages/deployments/deployments.json"), "utf8")) as { chains: Record<string, SourceChain> };
  const tokenList = JSON.parse(readFileSync(join(RATE_REPO, "packages/token-list/build/iter-default.tokenlist.json"), "utf8")) as { tokens: Array<{ chainId: number; address: string }> };
  const consts = readFileSync(join(RATE_REPO, "apps/web/consts/index.ts"), "utf8");

  const chainsOut: Record<string, unknown> = {};
  const manifestContracts: Record<string, Record<string, unknown>> = {};
  const manifestTokens: Record<string, unknown[]> = {};

  for (const chainId of CHAIN_IDS) {
    const source = deployments.chains[String(chainId)];
    if (!source) throw new Error(`deployments.json has no chain ${chainId}`);
    const rpcUrl = PINNED_RPC[chainId];
    if (!rpcUrl) throw new Error(`no pinned RPC for chain ${chainId}`);
    // Compared without a trailing slash: the same endpoint is written both ways upstream.
    if (source.rpcUrls[0]?.replace(/\/$/, "") !== rpcUrl) throw new Error(`deployments.json names ${source.rpcUrls[0]} for chain ${chainId}, but ${rpcUrl} is pinned here. Review the change, then update PINNED_RPC.`);
    const client = createPublicClient({ transport: http(rpcUrl) });
    if ((await client.getChainId()) !== chainId) throw new Error(`${rpcUrl} is not chain ${chainId}`);

    const gateway = new RegExp(`"${source.name}":\\s*"(https://gateway-api[^"]+)"`).exec(consts)?.[1];
    if (!gateway) throw new Error(`no gateway URL for ${source.name} in apps/web/consts/index.ts`);
    if (new URL(gateway).host !== PINNED_GATEWAY_HOST[chainId]) throw new Error(`gateway ${gateway} for chain ${chainId} is not on the pinned host ${PINNED_GATEWAY_HOST[chainId]}`);

    const contracts: Record<string, { address: Address; startBlock: number }> = {};
    manifestContracts[String(chainId)] = {};
    for (const [key, entry] of Object.entries(source.contracts)) {
      const address = getAddress(entry.address);
      // Known limits: a proxy using custom storage slots, or a diamond, reads as "none" here.
      // `source` points a reviewer at the deployment record for exactly that reason.
      const { code, proxy } = await detectProxy(client, address);
      if (!code) throw new Error(`${key} ${address} has no code on chain ${chainId}`);
      contracts[key] = { address, startBlock: entry.startBlock };

      // A deployment entry that is also a listed TOKEN (Monad's wrappedNative is its WMON) is a token, not a contract.
      const isToken = tokenList.tokens.some((t) => t.chainId === chainId && getAddress(t.address) === address);
      if (!MANIFEST_EXCLUDE.has(key) && !isToken) manifestContracts[String(chainId)]![key] = { address, role: ROLES[key] ?? "other", source: SOURCE_URL, proxy: proxy.type === "transparent" ? { type: proxy.type, admin: proxy.admin } : { type: proxy.type } };
      console.log(`chain ${chainId}  ${key.padEnd(20)} ${address}  code ${(code.length - 2) / 2} bytes  proxy ${proxy.type}`);
    }

    const wrappedNative = contracts.weth?.address.toLowerCase();
    manifestTokens[String(chainId)] = [];
    for (const row of tokenList.tokens.filter((t) => t.chainId === chainId)) {
      const address = getAddress(row.address);
      const [symbol, name, decimals] = await Promise.all([
        client.readContract({ address, abi: erc20Abi, functionName: "symbol" }),
        client.readContract({ address, abi: erc20Abi, functionName: "name" }),
        client.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
      ]);
      // Canonical: the chain's wrapped native, and Arc's system USDC precompile-style address.
      const canonical = address.toLowerCase() === wrappedNative || /^0x36(00){19}$/i.test(address);
      manifestTokens[String(chainId)]!.push({ address, symbol, name, decimals, trust: canonical ? "canonical" : "listed" });
      console.log(`chain ${chainId}  token ${symbol.padEnd(8)} ${address}  decimals ${decimals}`);
    }

    chainsOut[String(chainId)] = { name: source.name, chainId, rpcUrl, nativeCurrency: { name: source.nativeCurrency.name, symbol: source.nativeCurrency.symbol, decimals: source.nativeCurrency.decimals }, gatewayUrl: gateway, explorerUrl: source.blockExplorerUrl, contracts };
  }

  const generatedDir = join(PACKAGE_ROOT, "src/rate/generated");
  mkdirSync(generatedDir, { recursive: true });
  writeFileSync(
    join(generatedDir, "deployments.ts"),
    `// GENERATED by scripts/vendor-rate.ts from iter-monorepo@${commit}. Do not edit by hand.\n` +
      `// Source of every address: packages/deployments/deployments.json in that repo; each was checked for code onchain.\n` +
      `export const RATE_SOURCE_COMMIT = ${JSON.stringify(commit)};\n\n` +
      `export const RATE_DEPLOYMENTS = ${JSON.stringify(chainsOut, null, 2)} as const;\n`,
  );

  const abiDir = join(PACKAGE_ROOT, "src/rate/abis");
  mkdirSync(abiDir, { recursive: true });
  for (const [file] of ABIS) copyFileSync(join(RATE_REPO, "packages/abis/src", file), join(abiDir, file));
  writeFileSync(
    join(abiDir, "index.ts"),
    `// GENERATED by scripts/vendor-rate.ts from iter-monorepo@${commit}. The sibling files are byte-for-byte copies.\n` +
      ABIS.map(([file, name]) => `export { ${name} } from "./${file.replace(/\.ts$/, "")}";`).join("\n") +
      "\n",
  );

  const manifestPath = join(PACKAGE_ROOT, "registry/rate/manifest.json");
  mkdirSync(dirname(manifestPath), { recursive: true });
  const GENERATED_KEYS = new Set(["manifestVersion", "id", "name", "version", "homepage", "chains", "contracts", "tokens", "actions"]);
  const handAuthored: Record<string, unknown> = {};
  let actions: unknown = {};
  // Hand-authored with the actions: bumped by whoever changes them, never by this script.
  let version = "0.1.0";
  try {
    const existing = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown> & { actions?: unknown; version?: string };
    actions = existing.actions ?? {};
    version = existing.version ?? version;
    // Anything else a reviewer added by hand (an icon, the server's address) is theirs. This script regenerates
    // addresses and tokens; it must not delete a reviewed field inside a diff that looks like an address refresh.
    for (const [key, value] of Object.entries(existing)) if (!GENERATED_KEYS.has(key)) handAuthored[key] = value;
  } catch {
    // First run: no manifest yet. Actions are authored by hand in a later plan and preserved here.
  }
  const manifest = {
    manifestVersion: 1,
    id: "rate",
    name: "Rate",
    version,
    homepage: "https://rate.limo",
    chains: [...CHAIN_IDS],
    contracts: manifestContracts,
    tokens: manifestTokens,
    actions,
    ...handAuthored,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${manifestPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
