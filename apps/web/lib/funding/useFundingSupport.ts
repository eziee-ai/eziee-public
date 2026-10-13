"use client";

import { useQuery } from "@tanstack/react-query";

/**
 * Whether "From another chain" and "To another chain" exist for a network (spec §8.1). They render only when
 * this is true. It is false for every testnet, and everywhere until a funding key is configured, so today
 * neither section appears.
 */
export function useFundingSupport(chainId: number): boolean {
  const support = useQuery({
    queryKey: ["funding-support"],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const response = await fetch("/api/funding");
      if (!response.ok) throw new Error("funding");
      return ((await response.json()) as { chains: number[] }).chains;
    },
  });
  return support.data?.includes(chainId) ?? false;
}
