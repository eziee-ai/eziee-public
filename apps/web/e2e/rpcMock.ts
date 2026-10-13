import type { BrowserContext, Route } from "@playwright/test";
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, keccak256, multicall3Abi, numberToHex, type Hex } from "viem";

/**
 * A JSON-RPC stand-in for the two testnets, so transfer flows run end to end
 * (the wallet frame really signs and "broadcasts") without funded accounts or
 * third-party uptime. Only what viem asks for during a read, a fee estimate, a
 * send and a receipt wait is answered; anything else fails loudly.
 */

const CHAIN_BY_HOST: Record<string, number> = { "rpc.testnet.arc.network": 5042002, "testnet.riselabs.xyz": 11155931, "testnet-rpc.monad.xyz": 10143 };
const BLOCK_HASH = `0x${"cd".repeat(32)}` as Hex;

const SELECTOR = { balanceOf: "0x70a08231", decimals: "0x313ce567", symbol: "0x95d89b41", name: "0x06fdde03", aggregate3: "0x82ad56cb", getEthBalance: "0x4d2301cc", allowance: "0xdd62ed3e" } as const;

export interface RpcMock {
  /** Raw signed transactions the app broadcast, in order. */
  sent: Hex[];
  /** Lowercased token addresses whose `balanceOf` reverts from now on, as a broken or paused token's does. */
  revertBalanceOf: Set<string>;
}

export interface RpcMockOptions {
  /** ERC-20 balances in base units, keyed by lowercased token address. */
  tokenBalances: Record<string, bigint>;
  /** Tokens that exist: they have code, and answer `symbol`, `name` (the symbol unless given) and `decimals`. */
  tokenMeta: Record<string, { symbol: string; decimals: number; name?: string }>;
  nativeBalance: bigint;
  receiptStatus?: "success" | "reverted";
  /**
   * The logs a broadcast transaction's receipt carries, keyed off its raw bytes. An action is only "confirmed" when its
   * receipt shows what it did (a swap's Transfer to the signer), so a test that expects a fill supplies one here.
   */
  receiptLogs?: (raw: Hex) => Array<{ address: Hex; topics: Hex[]; data: Hex }>;
  /**
   * Fixed answers for contract reads, keyed `${lowercase address}:${selector}`. Checked before everything else.
   * A function is given the whole calldata, for a read whose answer depends on its ARGUMENTS as
   * `BandPoolFactory.getPool(base, quote)` does: one order names a pool, the other names nothing.
   */
  calls?: Record<string, Hex | ((data: Hex) => Hex)>;
  /** Selectors whose eth_call (a simulation of a state-changing call) succeeds with empty return data. */
  simulateOk?: string[];
  /** Make eth_gasPrice fail, as a flaky RPC does. */
  failGasPrice?: boolean;
}

interface RpcRequest {
  id: number | string;
  method: string;
  params?: unknown[];
}

export async function mockRpc(context: BrowserContext, options: RpcMockOptions): Promise<RpcMock> {
  const state: RpcMock = { sent: [], revertBalanceOf: new Set() };

  const ethCall = (to: string, data: Hex): Hex => {
    const selector = data.slice(0, 10);
    // wagmi's public client batches reads through Multicall3.aggregate3 when the chain defines it.
    if (selector === SELECTOR.aggregate3) {
      const { args } = decodeFunctionData({ abi: multicall3Abi, data });
      const calls = args![0] as ReadonlyArray<{ target: string; allowFailure: boolean; callData: Hex }>;
      const results = calls.map((inner) => {
        try {
          return { success: true, returnData: ethCall(inner.target.toLowerCase(), inner.callData) };
        } catch {
          return { success: false, returnData: "0x" as Hex };
        }
      });
      return encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: results });
    }
    // Newer viem reads the native balance through Multicall3 too, when batching is on.
    const fixed = options.calls?.[`${to}:${selector}`];
    if (fixed !== undefined) return typeof fixed === "function" ? fixed(data) : fixed;
    if (selector === SELECTOR.getEthBalance) return encodeAbiParameters([{ type: "uint256" }], [options.nativeBalance]);
    if (selector === SELECTOR.allowance) return encodeAbiParameters([{ type: "uint256" }], [0n]);
    if (options.simulateOk?.includes(selector)) return "0x";
    const meta = options.tokenMeta[to];
    if (selector === SELECTOR.balanceOf && state.revertBalanceOf.has(to)) throw Object.assign(new Error("execution reverted"), { code: 3, data: "0x" });
    if (selector === SELECTOR.balanceOf) return encodeAbiParameters([{ type: "uint256" }], [options.tokenBalances[to] ?? 0n]);
    if (selector === SELECTOR.decimals && meta) return encodeAbiParameters([{ type: "uint8" }], [meta.decimals]);
    if (selector === SELECTOR.symbol && meta) return encodeAbiParameters([{ type: "string" }], [meta.symbol]);
    if (selector === SELECTOR.name && meta) return encodeAbiParameters([{ type: "string" }], [meta.name ?? meta.symbol]);
    throw new Error(`rpcMock: unexpected eth_call ${selector} to ${to}`);
  };

  const answer = (chainId: number, request: RpcRequest): unknown => {
    const params = request.params ?? [];
    switch (request.method) {
      case "eth_chainId":
        return numberToHex(chainId);
      case "eth_blockNumber":
        return "0x100";
      case "eth_getBalance":
        return numberToHex(options.nativeBalance);
      case "eth_getCode":
        // Only the tokens this mock knows are contracts; every other address is empty, as on a real chain.
        return options.tokenMeta[String(params[0]).toLowerCase()] ? "0x6000" : "0x";
      case "eth_gasPrice":
        if (options.failGasPrice) throw new Error("rpcMock: eth_gasPrice is down");
        return "0x3b9aca00";
      case "eth_maxPriorityFeePerGas":
        return "0x3b9aca00";
      case "eth_estimateGas":
        return "0x10000";
      case "eth_getTransactionCount":
        return "0x0";
      case "eth_getBlockByNumber":
        return { number: "0x100", hash: BLOCK_HASH, parentHash: BLOCK_HASH, timestamp: "0x6a000000", baseFeePerGas: "0x3b9aca00", gasLimit: "0x1c9c380", gasUsed: "0x0", transactions: [], miner: `0x${"00".repeat(20)}`, difficulty: "0x0", totalDifficulty: "0x0", size: "0x0", nonce: "0x0000000000000000", extraData: "0x", logsBloom: `0x${"00".repeat(256)}`, uncles: [] };
      case "eth_call": {
        const call = params[0] as { to?: string; data?: Hex };
        return ethCall((call.to ?? "").toLowerCase(), call.data ?? "0x");
      }
      case "eth_sendRawTransaction":
        state.sent.push(params[0] as Hex);
        // The real hash of what was broadcast, as a node would answer.
        return keccak256(params[0] as Hex);
      case "eth_getTransactionReceipt": {
        // Only a transaction that was actually broadcast has a receipt.
        const asked = String(params[0]).toLowerCase();
        const raw = state.sent.find((sent) => keccak256(sent) === asked);
        if (!raw) return null;
        const logs = (options.receiptLogs?.(raw) ?? []).map((log, i) => ({ ...log, blockHash: BLOCK_HASH, blockNumber: "0x100", transactionHash: asked, transactionIndex: "0x0", logIndex: numberToHex(i), removed: false }));
        return { transactionHash: asked, transactionIndex: "0x0", blockHash: BLOCK_HASH, blockNumber: "0x100", from: `0x${"00".repeat(20)}`, to: `0x${"00".repeat(20)}`, cumulativeGasUsed: "0x10000", gasUsed: "0x10000", effectiveGasPrice: "0x3b9aca00", contractAddress: null, logs, logsBloom: `0x${"00".repeat(256)}`, status: options.receiptStatus === "reverted" ? "0x0" : "0x1", type: "0x2" };
      }
      case "eth_getTransactionByHash":
        return null;
      default:
        throw new Error(`rpcMock: unexpected method ${request.method}`);
    }
  };

  const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST, OPTIONS" };

  const handle = async (route: Route) => {
    // A JSON POST to another origin is preflighted; an unanswered preflight reads as a dead RPC.
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const url = new URL(route.request().url());
    const chainId = CHAIN_BY_HOST[url.host];
    const body = route.request().postDataJSON() as RpcRequest | RpcRequest[];
    const one = (request: RpcRequest) => {
      try {
        return { jsonrpc: "2.0", id: request.id, result: answer(chainId!, request) };
      } catch (error) {
        const code = typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : -32601;
        return { jsonrpc: "2.0", id: request.id, error: { code, message: error instanceof Error ? error.message : String(error), ...(code === 3 ? { data: "0x" } : {}) } };
      }
    };
    await route.fulfill({ status: 200, contentType: "application/json", headers: CORS, body: JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)) });
  };

  for (const host of Object.keys(CHAIN_BY_HOST)) await context.route(`https://${host}/**`, handle);
  return state;
}
