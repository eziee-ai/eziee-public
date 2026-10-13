/** A way to fund the wallet from somewhere the app's protocols do not live (spec §8.1). */
export interface SourceAsset {
  assetId: string;
  blockchain: string;
  symbol: string;
  decimals: number;
  contractAddress?: string;
}

export interface FundingQuote {
  depositAddress: string;
  depositMemo?: string;
  amountIn: string;
  amountInFormatted: string;
  amountOut: string;
  amountOutFormatted: string;
  minAmountOut: string;
  /** Seconds. */
  timeEstimate: number;
  /** ISO time after which an unfilled deposit is refunded. */
  deadline?: string;
}

export const FUNDING_STATUSES = ["KNOWN_DEPOSIT_TX", "PENDING_DEPOSIT", "INCOMPLETE_DEPOSIT", "PROCESSING", "SUCCESS", "REFUNDED", "FAILED"] as const;
export type FundingStatus = (typeof FUNDING_STATUSES)[number];

export interface FundingQuoteRequest {
  direction: "in" | "out";
  /** The app network the funds arrive on ("in") or leave from ("out"). */
  chainId: number;
  /** The asset on the app network, by token address or "native". */
  appAsset: string;
  /** The asset on the other chain, by the route's own asset id. */
  otherAssetId: string;
  /** Base units of the asset being SENT. */
  amount: string;
  /** "in": where a refund goes on the other chain. "out": where the funds should arrive on the other chain. */
  otherAddress: string;
  slippageBps: number;
}

export interface FundingRoute {
  id: string;
  supportsDestination(chainId: number): boolean;
  sources(): Promise<SourceAsset[]>;
  quote(request: FundingQuoteRequest & { account: `0x${string}` }): Promise<FundingQuote>;
  submit(request: { txHash: string; depositAddress: string; memo?: string }): Promise<void>;
  status(request: { depositAddress: string; depositMemo?: string }): Promise<{ status: FundingStatus; refundReason?: string }>;
}
