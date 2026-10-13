// A tiny JSON-RPC "chain" for the SERVER side of end-to-end tests (the browser's RPC is mocked in the page).
// The test server is pointed at it with RPC_URL_<chainId>, so nothing in the suite depends on a live testnet.
// It knows one token, which calls itself USDC, and it turns a raw `transfer` it is sent into a mined receipt with
// the Transfer log a real token would emit, so a deposit can be followed from the wallet to the credit ledger.
import { createServer } from "node:http";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, erc20Abi, keccak256, numberToHex, parseTransaction, recoverTransactionAddress, toFunctionSelector } from "viem";

const PORT = Number(process.env.MOCK_CHAIN_PORT);
const CHAIN_ID = Number(process.env.MOCK_CHAIN_ID);
if (!PORT || !CHAIN_ID) throw new Error("mock chain: MOCK_CHAIN_PORT and MOCK_CHAIN_ID are required");
// Only THESE addresses are tokens here. Anything else has no code and answers nothing, as on a real chain, so a
// wrong token address in the server's configuration behaves like one.
const TOKENS = new Set((process.env.MOCK_CHAIN_TOKENS ?? "").toLowerCase().split(",").filter(Boolean));
// One more made-up token, for adding a token by address. It holds a balance, so the page has something to show.
const EXTRA_TOKEN = (process.env.MOCK_CHAIN_EXTRA_TOKEN ?? "").toLowerCase();
const EXTRA = { symbol: "TEST", name: "Test Token", decimals: 6n, balance: 5_000_000n };
const isToken = (address) => TOKENS.has(address) || (EXTRA_TOKEN !== "" && address === EXTRA_TOKEN);
// Transactions are mined at MINED_AT. A test moves the head (POST /__control {"head": n}) to watch a deposit confirm.
const MINED_AT = 0x100n;
let head = MINED_AT;
const BLOCK_HASH = `0x${"11".repeat(32)}`;
const receipts = new Map();
const SELECTOR = { symbol: toFunctionSelector("function symbol()"), decimals: toFunctionSelector("function decimals()"), name: toFunctionSelector("function name()"), balanceOf: toFunctionSelector("function balanceOf(address)") };
const text = (value) => encodeAbiParameters([{ type: "string" }], [value]);
const uint = (value) => encodeAbiParameters([{ type: "uint256" }], [value]);

async function handle(method, params) {
  switch (method) {
    case "eth_chainId":
      return numberToHex(CHAIN_ID);
    case "eth_blockNumber":
      return numberToHex(head);
    case "eth_getCode":
      return isToken(String(params[0]).toLowerCase()) ? "0x6000" : "0x";
    case "eth_getBlockByNumber":
      return { number: params[0], hash: BLOCK_HASH, parentHash: `0x${"00".repeat(32)}`, timestamp: "0x1", transactions: [] };
    case "eth_getBalance":
      return "0x0";
    case "eth_call": {
      const selector = String(params[0]?.data ?? "0x").slice(0, 10);
      const to = String(params[0]?.to ?? "").toLowerCase();
      if (!isToken(to)) return "0x";
      if (to === EXTRA_TOKEN) {
        if (selector === SELECTOR.symbol) return text(EXTRA.symbol);
        if (selector === SELECTOR.name) return text(EXTRA.name);
        if (selector === SELECTOR.decimals) return uint(EXTRA.decimals);
        if (selector === SELECTOR.balanceOf) return uint(EXTRA.balance);
        return uint(0n);
      }
      if (selector === SELECTOR.symbol) return text("USDC");
      if (selector === SELECTOR.name) return text("USD Coin");
      if (selector === SELECTOR.decimals) return uint(6n);
      return uint(0n); // balanceOf, allowance and anything else: zero
    }
    case "eth_sendRawTransaction": {
      const raw = params[0];
      const tx = parseTransaction(raw);
      const from = await recoverTransactionAddress({ serializedTransaction: raw });
      const hash = keccak256(raw);
      const logs = [];
      try {
        const call = decodeFunctionData({ abi: erc20Abi, data: tx.data });
        if (call.functionName === "transfer") {
          const [to, amount] = call.args;
          logs.push({ address: tx.to, topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from, to } }), data: uint(amount), logIndex: "0x0", blockNumber: numberToHex(MINED_AT), blockHash: BLOCK_HASH, transactionHash: hash, transactionIndex: "0x0", removed: false });
        }
      } catch {
        // Not an ERC-20 call: a receipt with no logs.
      }
      receipts.set(hash, { transactionHash: hash, transactionIndex: "0x0", blockHash: BLOCK_HASH, blockNumber: numberToHex(MINED_AT), from, to: tx.to, cumulativeGasUsed: "0x10000", gasUsed: "0x10000", effectiveGasPrice: "0x3b9aca00", contractAddress: null, logs, logsBloom: `0x${"00".repeat(256)}`, status: "0x1", type: "0x2" });
      return hash;
    }
    case "eth_getTransactionReceipt":
      return receipts.get(params[0]) ?? null;
    default:
      throw Object.assign(new Error(`mock chain: ${method} is not supported`), { code: -32601 });
  }
}

createServer((request, response) => {
  if (request.method !== "POST") return void response.writeHead(200, { "content-type": "text/plain" }).end("mock chain");
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", async () => {
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return void response.writeHead(400).end();
    }
    if (request.url === "/__control") {
      if (typeof body.head === "number") head = BigInt(body.head);
      return void response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ head: Number(head) }));
    }
    const answer = async (rpc) => {
      try {
        return { jsonrpc: "2.0", id: rpc.id, result: await handle(rpc.method, rpc.params ?? []) };
      } catch (error) {
        return { jsonrpc: "2.0", id: rpc.id, error: { code: error.code ?? -32000, message: error.message } };
      }
    };
    const result = Array.isArray(body) ? await Promise.all(body.map(answer)) : await answer(body);
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
  });
}).listen(PORT, "127.0.0.1", () => console.log(`mock chain ${CHAIN_ID} on ${PORT}`));
