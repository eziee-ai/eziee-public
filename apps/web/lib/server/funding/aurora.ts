import { z } from "zod";
import { FUNDING_STATUSES, type FundingQuote, type FundingRoute, type SourceAsset } from "@/lib/funding/types";

/**
 * Aurora Intents (spec §8.1): funds arrive on, or leave from, an app network by way of another chain.
 * Written against the published Swap API reference (docs.intents.aurora.dev/api-reference/swap-api-reference):
 *   GET  /api/tokens/{apiKey} · POST /api/quote/{apiKey} · POST /api/deposit/submit/{apiKey} · GET /api/status/{apiKey}
 *
 * The API key is part of the URL PATH. So this runs on the server only, and nothing that could carry a URL (an
 * error's message, a log line, a response) is ever passed on: every failure here is a fixed sentence.
 *
 * Two addresses decide where money goes, and neither is left to the page:
 *   funding IN  — the recipient is the signed-in account; the person supplies only where a REFUND goes.
 *   funding OUT — the refund comes back to the signed-in account; the person supplies the recipient.
 */

const BASE_URL = "https://intents-api.aurora.dev";
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 2 * 1024 * 1024;
const TOKENS_TTL_MS = 10 * 60_000;
const MAX_SLIPPAGE_BPS = 5000;

/**
 * The API's name for each EVM network it can deliver to, by chain id. Only these can ever be a destination;
 * an app network that is not here (every testnet) has no funding route, and the interface hides it.
 */
export const AURORA_BLOCKCHAIN: Readonly<Record<number, string>> = { 1: "eth", 10: "op", 56: "bsc", 100: "gnosis", 137: "pol", 8453: "base", 42161: "arb", 43114: "avax", 534352: "scroll" };

const token = z.object({ assetId: z.string().min(1).max(200), decimals: z.number().int().min(0).max(36), blockchain: z.string().min(1).max(40), symbol: z.string().min(1).max(40), contractAddress: z.string().max(200).optional() });
const tokensResponse = z.object({ tokens: z.array(token).max(5000) });
const amountString = z.string().regex(/^[0-9]{1,78}$/);
const quoteResponse = z.object({
  quote: z.object({
    depositAddress: z.string().min(1).max(200),
    depositMemo: z.string().max(200).optional(),
    amountIn: amountString,
    amountInFormatted: z.string().max(80),
    amountOut: amountString,
    amountOutFormatted: z.string().max(80),
    minAmountOut: amountString,
    timeEstimate: z.number().min(0).max(7 * 24 * 3600),
    deadline: z.string().max(40).optional(),
  }),
});
const statusResponse = z.object({ status: z.enum(FUNDING_STATUSES), swapDetails: z.object({ refundReason: z.string().max(300).optional() }).partial().optional() });

/** An address on some other chain. Formats differ too much to check properly; this only refuses what no address contains. */
const otherChainAddress = z.string().regex(/^[A-Za-z0-9._:-]{2,128}$/, "that does not look like an address");

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export class FundingError extends Error {
  constructor(
    readonly code: "NOT_SUPPORTED" | "INVALID_REQUEST" | "UNAVAILABLE",
    message: string,
  ) {
    super(message);
  }
}

export function createAuroraIntents(options: { apiKey: string | undefined; fetch?: FetchLike; now?: () => number }): FundingRoute {
  const { apiKey } = options;
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const now = options.now ?? Date.now;
  let tokensCache: { at: number; tokens: z.infer<typeof token>[] } | null = null;

  async function call<T>(path: string, schema: z.ZodType<T>, init?: { method: "POST"; body: unknown }): Promise<T> {
    if (!apiKey) throw new FundingError("NOT_SUPPORTED", "Funding from another chain is not switched on here.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await doFetch(`${BASE_URL}${path.replace("{apiKey}", encodeURIComponent(apiKey))}`, init ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(init.body), signal: controller.signal } : { signal: controller.signal });
      const text = await response.text();
      if (!response.ok || text.length > MAX_BYTES) throw new Error("upstream");
      return schema.parse(JSON.parse(text));
    } catch (error) {
      if (error instanceof FundingError) throw error;
      // Deliberately nothing of `error`: its message can contain the request URL, and the URL contains the key.
      throw new FundingError("UNAVAILABLE", "The funding service could not be reached, or answered with something unexpected.");
    } finally {
      clearTimeout(timer);
    }
  }

  async function tokens() {
    if (tokensCache && now() - tokensCache.at < TOKENS_TTL_MS) return tokensCache.tokens;
    const listed = (await call("/api/tokens/{apiKey}", tokensResponse)).tokens;
    tokensCache = { at: now(), tokens: listed };
    return listed;
  }

  const supportsDestination = (chainId: number) => Boolean(apiKey) && Object.hasOwn(AURORA_BLOCKCHAIN, chainId);

  return {
    id: "aurora-intents",
    supportsDestination,
    async sources(): Promise<SourceAsset[]> {
      return (await tokens()).map(({ assetId, blockchain, symbol, decimals, contractAddress }) => ({ assetId, blockchain, symbol, decimals, ...(contractAddress ? { contractAddress } : {}) }));
    },
    async quote(request): Promise<FundingQuote> {
      if (!supportsDestination(request.chainId)) throw new FundingError("NOT_SUPPORTED", "Funding from another chain is not supported on this network.");
      if (!/^[1-9][0-9]{0,77}$/.test(request.amount)) throw new FundingError("INVALID_REQUEST", "The amount must be a whole number of base units, above zero.");
      if (!Number.isInteger(request.slippageBps) || request.slippageBps < 1 || request.slippageBps > MAX_SLIPPAGE_BPS) throw new FundingError("INVALID_REQUEST", "The slippage limit must be between 0.01% and 50%.");
      if (!otherChainAddress.safeParse(request.otherAddress).success) throw new FundingError("INVALID_REQUEST", "That address is not one this can send to.");

      const listed = await tokens();
      const blockchain = AURORA_BLOCKCHAIN[request.chainId]!;
      const appToken = listed.find((t) => t.blockchain === blockchain && (request.appAsset === "native" ? t.contractAddress === undefined : t.contractAddress?.toLowerCase() === request.appAsset.toLowerCase()));
      const otherToken = listed.find((t) => t.assetId === request.otherAssetId);
      if (!appToken || !otherToken) throw new FundingError("NOT_SUPPORTED", "That asset is not supported by the funding service.");
      // This route is for ANOTHER chain. The same network on both sides is a swap, which is a protocol's job here.
      if (otherToken.blockchain === blockchain) throw new FundingError("INVALID_REQUEST", "Choose an asset on a different network than the one being funded.");

      const funding = request.direction === "in";
      const body = {
        dry: false,
        swapType: "EXACT_INPUT",
        depositType: "ORIGIN_CHAIN",
        originAsset: funding ? otherToken.assetId : appToken.assetId,
        destinationAsset: funding ? appToken.assetId : otherToken.assetId,
        amount: request.amount,
        slippageTolerance: request.slippageBps,
        // Where the money goes, and where it comes back to if it cannot. See the note at the top of this file.
        recipient: funding ? request.account : request.otherAddress,
        recipientType: "DESTINATION_CHAIN",
        refundTo: funding ? request.otherAddress : request.account,
        refundType: "ORIGIN_CHAIN",
      };
      const { quote } = await call("/api/quote/{apiKey}", quoteResponse, { method: "POST", body });
      if (BigInt(quote.minAmountOut) > BigInt(quote.amountOut) || BigInt(quote.amountOut) === 0n) throw new FundingError("UNAVAILABLE", "The funding service answered with a quote that does not add up.");
      return quote;
    },
    async submit(request) {
      await call("/api/deposit/submit/{apiKey}", z.unknown(), { method: "POST", body: { txHash: request.txHash, depositAddress: request.depositAddress, ...(request.memo ? { memo: request.memo } : {}) } });
    },
    async status(request) {
      const query = new URLSearchParams({ depositAddress: request.depositAddress, ...(request.depositMemo ? { depositMemo: request.depositMemo } : {}) });
      const result = await call(`/api/status/{apiKey}?${query.toString()}`, statusResponse);
      const refundReason = result.swapDetails?.refundReason;
      return { status: result.status, ...(refundReason ? { refundReason } : {}) };
    },
  };
}
