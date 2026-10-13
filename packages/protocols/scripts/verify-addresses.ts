/**
 * Every vendored address must have code on its chain (spec §6.1). Runs with the
 * package's tests, so a redeploy or a bad vendoring run fails the build instead
 * of surfacing as an empty screen. Uses Foundry's `cast code`, the same check a
 * reviewer would run by hand.
 */
import { execFileSync } from "node:child_process";
import { RATE_DEPLOYMENTS } from "../src/rate/generated/deployments";
import { rateManifest } from "../src/rate/manifest";

let failures = 0;
let checked = 0;

function check(label: string, address: string, rpcUrl: string) {
  let code = "";
  // Three attempts: a testnet RPC hiccup should not turn a green build red, and a build
  // that goes red for no reason is a check someone eventually deletes.
  for (let attempt = 1; ; attempt++) {
    try {
      code = execFileSync("cast", ["code", address, "--rpc-url", rpcUrl], { encoding: "utf8", timeout: 30_000 }).trim();
      break;
    } catch (error) {
      if (attempt < 3) continue;
      console.error(`FAIL ${label} ${address}: cast code failed three times (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`);
      failures += 1;
      return;
    }
  }
  checked += 1;
  if (code === "0x" || code === "") {
    console.error(`FAIL ${label} ${address}: no code`);
    failures += 1;
  }
}

for (const chain of Object.values(RATE_DEPLOYMENTS)) {
  for (const [key, contract] of Object.entries(chain.contracts)) check(`${chain.name} ${key}`, contract.address, chain.rpcUrl);
  for (const token of rateManifest.tokens[String(chain.chainId)] ?? []) check(`${chain.name} token ${token.symbol}`, token.address, chain.rpcUrl);
}

if (failures > 0) {
  console.error(`${failures} address check(s) failed`);
  process.exit(1);
}
console.log(`verify-addresses: ${checked} addresses have code`);
