/**
 * Live smoke run of every Rate read against a real testnet. Not part of the tests: it
 * depends on third-party uptime. Usage: pnpm --filter @repo/protocols smoke:rate [chainIndex] [account]
 */
import { createPublicClient, http } from "viem";
import { createRateAdapter, rateChains } from "../src/rate/index";

const rate = createRateAdapter();
const chain = rateChains[Number(process.argv[2] ?? 0)]!;
const client = createPublicClient({ chain, transport: http() });
const account = (process.argv[3] ?? "0x0000000000000000000000000000000000000001") as `0x${string}`;
const ctx = { chainId: chain.id, account, client };
const pools = (await rate.reads.pools!.run({ pageSize: 3 }, ctx)) as { pools: Array<{ symbol: string; base: { address: string }; quote: { address: string } }>; totalCount: number };
console.log("pools", pools.totalCount, pools.pools.map((p) => p.symbol));
const first = pools.pools[0]!;
console.log("quote", JSON.stringify(await rate.reads.quote!.run({ tokenIn: first.quote.address, tokenOut: first.base.address, amountIn: "10" }, ctx)).slice(0, 300));
console.log("orderbook", JSON.stringify(await rate.reads.orderbook!.run({ base: first.base.address, quote: first.quote.address }, ctx)).slice(0, 200));
console.log("orders", JSON.stringify(await rate.reads.orders!.run({ pageSize: 2 }, ctx)).slice(0, 300));
console.log("positions", JSON.stringify(await rate.reads.positions!.run({}, ctx)).slice(0, 250));
console.log("balances", JSON.stringify(await rate.reads.balances!.run({}, ctx)));
console.log("tokenInfo", JSON.stringify(await rate.reads.tokenInfo!.run({ token: first.base.address }, ctx)));
