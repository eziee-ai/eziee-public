"use client";

import { Eye, EyeOff, Pin, PinOff, Trash2 } from "lucide-react";
import { useState } from "react";
import { formatUnits } from "viem";
import { useWalletAccount, useWalletConnect } from "@repo/wallet";
import { cn } from "@repo/ui/cn";
import { UnreviewedPill } from "@/components/transfer/AssetList";
import { BalanceError, radioGroupKeyDown } from "@/components/transfer/TransferShell";
import { appChains } from "@/lib/chains";
import { useChatOptions, useChatSelection } from "@/lib/chat/useChatOptions";
import { arrangeTokens } from "@/lib/tokens/arrange";
import { removeCustomToken, useCustomTokens } from "@/lib/tokens/customTokens";
import { toggleHide, togglePin, tokenId, usePrefs } from "@/lib/tokens/tokenPrefs";
import { useTransferAssets } from "@/lib/transfer/useTransferAssets";
import type { TransferAsset } from "@/lib/transfer/withdrawForm";
import { AddTokenForm } from "./AddTokenForm";

const ICON_BUTTON = "grid h-11 w-11 shrink-0 place-items-center rounded-xl text-[color:var(--m-text-secondary)] transition-colors hover:bg-[color:var(--m-surface-2)] aria-pressed:text-[color:var(--m-primary-fg)]";

/** The wallet's tokens on one network: balances, pins, hidden rows, and tokens added by address. */
export function TokensPanel() {
  // The same network choice as the chat's, so the two pages agree.
  const [selection, select] = useChatSelection();
  const options = useChatOptions();
  const chain = appChains.find((c) => c.id === selection.chainId) ?? appChains[0];
  const { address, isConnected } = useWalletAccount();
  const { open, ready } = useWalletConnect();
  const custom = useCustomTokens(chain.id, address);
  const prefs = usePrefs(chain.id, address);
  const { assets, isLoading, isError, unreadable, refetch } = useTransferAssets(chain.id, address, custom);
  const [showHidden, setShowHidden] = useState(false);
  const { shown, hidden } = arrangeTokens(assets, prefs);

  function chooseChain(chainId: number) {
    const protocols = options.data?.protocols;
    // A protocol that is not on the new network falls back to Auto, as the chat's own picker does.
    const protocol = protocols && !protocols.some((p) => p.id === selection.protocol && p.chains.includes(chainId)) ? "auto" : selection.protocol;
    select({ chainId, protocol });
    setShowHidden(false);
  }

  const row = (asset: TransferAsset) => (
    <TokenRow
      key={asset.token}
      asset={asset}
      pinned={prefs.pinned.includes(tokenId(asset.token))}
      hidden={prefs.hidden.includes(tokenId(asset.token))}
      onPin={() => address && togglePin(chain.id, address, asset.token)}
      onHide={() => address && toggleHide(chain.id, address, asset.token)}
      onRemove={asset.trust === "unreviewed" ? () => address && removeCustomToken(chain.id, address, asset.token) : undefined}
    />
  );

  return (
    <main className="mx-auto flex w-full max-w-[560px] flex-col gap-4 px-4 py-8">
      <h1 className="text-2xl font-bold tracking-tight">Tokens</h1>

      <div role="radiogroup" aria-label="Network" onKeyDown={radioGroupKeyDown} className="flex gap-2">
        {appChains.map((c) => (
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={c.id === chain.id}
            tabIndex={c.id === chain.id ? 0 : -1}
            data-testid={`network-${c.id}`}
            onClick={() => chooseChain(c.id)}
            className={cn(
              "min-h-11 flex-1 rounded-xl border border-[color:var(--m-border)] px-3 text-sm font-medium transition-colors hover:bg-[color:var(--m-surface)]",
              c.id === chain.id && "border-[color:var(--m-primary-fg)] bg-[color:var(--m-surface-selected)] text-[color:var(--m-on-surface-selected)]",
            )}
          >
            {c.name}
          </button>
        ))}
      </div>

      {!isConnected || !address ? (
        <section className="flex flex-col gap-3.5 rounded-2xl border border-[color:var(--m-border)] bg-[color:var(--m-surface)] p-5">
          <h2 className="text-[15px] font-semibold">Connect to see your tokens</h2>
          <p className="text-sm text-[color:var(--m-text-secondary)]">Your balances are read from your passkey wallet.</p>
          <button type="button" data-testid="tokens-connect" disabled={!ready} onClick={open} className="min-h-11 self-start rounded-xl bg-[color:var(--m-primary)] px-5 text-sm font-semibold text-[color:var(--m-on-primary)] hover:bg-[color:var(--m-primary-hover)] disabled:opacity-60">
            Continue with passkey
          </button>
        </section>
      ) : (
        <>
          <section className="flex flex-col gap-2 rounded-2xl border border-[color:var(--m-border)] bg-[color:var(--m-surface)] p-3">
            {isLoading && assets.length === 0 ? (
              <div aria-busy="true" className="flex flex-col gap-2">
                {[0, 1].map((i) => (
                  <div key={i} className="h-14 animate-pulse rounded-xl bg-[color:var(--m-surface-2)]" />
                ))}
              </div>
            ) : (
              <ul data-testid="tokens-list" aria-label={`Tokens on ${chain.name}`} className="flex flex-col">
                {shown.map(row)}
                {unreadable.map((token) => (
                  <TokenRow
                    key={token.address}
                    asset={{ token: token.address, symbol: token.symbol, name: token.name, decimals: token.decimals, held: null, trust: "unreviewed" }}
                    onRemove={() => address && removeCustomToken(chain.id, address, token.address)}
                  />
                ))}
              </ul>
            )}
            {!isLoading && !isError && shown.length === 0 && <p className="px-2 py-3 text-sm text-[color:var(--m-text-secondary)]">No tokens to show on {chain.name}.</p>}
            {isError && <BalanceError chainName={chain.name} onRetry={refetch} />}
            {hidden.length > 0 && (
              <div className="flex flex-col border-t border-[color:var(--m-border)] pt-2">
                <button type="button" data-testid="tokens-hidden-toggle" aria-expanded={showHidden} aria-controls="tokens-hidden" onClick={() => setShowHidden((v) => !v)} className="flex min-h-11 items-center justify-between rounded-xl px-2 text-sm font-medium hover:bg-[color:var(--m-surface-2)]">
                  <span>Hidden ({hidden.length})</span>
                  <span className="text-[13px] text-[color:var(--m-text-secondary)]">{showHidden ? "Hide" : "Show"}</span>
                </button>
                {showHidden && (
                  <ul id="tokens-hidden" data-testid="tokens-hidden" aria-label="Hidden tokens" className="flex flex-col">
                    {hidden.map(row)}
                  </ul>
                )}
              </div>
            )}
          </section>

          <AddTokenForm key={`${chain.id}:${address}`} chainId={chain.id} chainName={chain.name} account={address} />
        </>
      )}
    </main>
  );
}

type RowAsset = Pick<TransferAsset, "token" | "symbol" | "name" | "decimals" | "trust"> & {
  /** `null`: the balance could not be read. Shown as unavailable, never as zero. */
  held: bigint | null;
};

function TokenRow({ asset, pinned = false, hidden = false, onPin, onHide, onRemove }: { asset: RowAsset; pinned?: boolean; hidden?: boolean; onPin?: () => void; onHide?: () => void; onRemove?: () => void }) {
  // Keyed by address: a custom token may call itself by any symbol, including a listed one's.
  const id = tokenId(asset.token);
  return (
    <li data-testid={`token-row-${id}`} className="flex min-h-14 items-center gap-2 rounded-xl px-2">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2 text-sm font-semibold">
          {asset.symbol}
          {asset.trust === "unreviewed" && <UnreviewedPill />}
        </span>
        <span className="truncate text-xs text-[color:var(--m-text-secondary)]">{asset.name}</span>
      </span>
      {asset.held === null ? (
        <span data-testid={`balance-unavailable-${id}`} className="min-w-0 truncate text-[13px] text-[color:var(--m-text-secondary)]">
          Balance unavailable
        </span>
      ) : (
        <span className="min-w-0 truncate font-dm-mono text-sm tabular-nums">{formatUnits(asset.held, asset.decimals)}</span>
      )}
      <span className="flex shrink-0">
        {onPin && (
          <button type="button" data-testid={`pin-${id}`} aria-pressed={pinned} aria-label={`Pin ${asset.symbol}`} title={pinned ? "Unpin" : "Pin to top"} onClick={onPin} className={ICON_BUTTON}>
            {pinned ? <PinOff aria-hidden className="h-[18px] w-[18px]" /> : <Pin aria-hidden className="h-[18px] w-[18px]" />}
          </button>
        )}
        {onHide && (
          <button type="button" data-testid={`hide-${id}`} aria-pressed={hidden} aria-label={`Hide ${asset.symbol}`} title={hidden ? "Show" : "Hide"} onClick={onHide} className={ICON_BUTTON}>
            {hidden ? <EyeOff aria-hidden className="h-[18px] w-[18px]" /> : <Eye aria-hidden className="h-[18px] w-[18px]" />}
          </button>
        )}
        {onRemove && (
          <button type="button" data-testid={`remove-${id}`} aria-label={`Remove ${asset.symbol}`} title="Remove" onClick={onRemove} className={ICON_BUTTON}>
            <Trash2 aria-hidden className="h-[18px] w-[18px]" />
          </button>
        )}
      </span>
    </li>
  );
}
