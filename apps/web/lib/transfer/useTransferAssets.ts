"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { erc20Abi, type Address, type PublicClient } from "viem";
import { createRateAdapter } from "@repo/protocols/rate";
import { appChains } from "@/lib/chains";
import type { CustomToken } from "@/lib/tokens/customTokens";
import { toTransferAssets, unlistedExtras, unreadableExtras } from "./assets";
import type { TransferAsset } from "./withdrawForm";

const rate = createRateAdapter();
const NO_EXTRA: readonly CustomToken[] = [];

interface BalancesRead {
  gas: { symbol: string; decimals: number; amount: string; sameAssetAs?: Address };
  balances: Array<{ token: Address | "native"; symbol: string; decimals: number; amount: string }>;
}

export interface TransferAssets {
  assets: TransferAsset[];
  /** The chain's gas asset. On Arc it is the same funds as the USDC token (`sameAssetAs`). */
  gas: BalancesRead["gas"] | null;
  isLoading: boolean;
  isError: boolean;
  /** Added tokens whose balance could not be read. They are not in `assets`, and are never shown as zero. */
  unreadable: CustomToken[];
  refetch: () => void;
}

/**
 * What the wallet holds on one chain: the protocol's listed tokens plus the native asset, never double-counted,
 * and any `extra` tokens the person added by address (labelled unreviewed).
 */
export function useTransferAssets(chainId: number, account: Address | undefined, extra: readonly CustomToken[] = NO_EXTRA): TransferAssets {
  const client = usePublicClient({ chainId });
  const query = useQuery({
    queryKey: ["transfer-assets", chainId, account],
    enabled: Boolean(account && client),
    refetchInterval: 15_000,
    queryFn: async (): Promise<BalancesRead> => (await rate.reads.balances!.run({}, { chainId, account, client: client as PublicClient })) as BalancesRead,
  });

  const registry = rate.tokens(chainId);
  const extras = unlistedExtras(extra, registry);
  // One `balanceOf` per token rather than a Multicall3 batch the chain may not have, each settled on its own:
  // one token that reverts must not take the others down with it.
  const extraQuery = useQuery({
    queryKey: ["transfer-assets-extra", chainId, account, extras.map((t) => t.address.toLowerCase()).join(",")],
    enabled: Boolean(account && client && extras.length > 0),
    refetchInterval: 15_000,
    queryFn: async (): Promise<Array<[string, string | null]>> => {
      const reads = await Promise.allSettled(extras.map((t) => (client as PublicClient).readContract({ address: t.address, abi: erc20Abi, functionName: "balanceOf", args: [account as Address] })));
      return extras.map((t, i) => {
        const read = reads[i]!;
        return [t.address.toLowerCase(), read.status === "fulfilled" ? read.value.toString() : null];
      });
    },
  });

  const nativeName = appChains.find((c) => c.id === chainId)?.nativeCurrency.name ?? "";
  const extraHeld = extraQuery.data ? new Map(extraQuery.data.map(([address, amount]) => [address, amount === null ? null : BigInt(amount)])) : undefined;
  const assets = toTransferAssets({ chainId, rows: query.data?.balances ?? [], registry, nativeName, extras, extraHeld });

  return {
    assets,
    gas: query.data?.gas ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
    unreadable: unreadableExtras(extras, registry, extraHeld),
    refetch: () => {
      void query.refetch();
      if (extras.length > 0) void extraQuery.refetch();
    },
  };
}
