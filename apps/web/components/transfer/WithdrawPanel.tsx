"use client";

import { useCallback, useMemo, useState } from "react";
import { formatUnits, getAddress, type Address, type Hex } from "viem";
import { useGasPrice } from "wagmi";
import { createRateAdapter } from "@repo/protocols/rate";
import { useWalletAccount, useWalletConnect } from "@repo/wallet";
import { WalletConfirmFrame } from "@/components/wallet/WalletConfirmFrame";
import { appChains } from "@/lib/chains";
import { useCustomTokens } from "@/lib/tokens/customTokens";
import { maxDepositable, transferGasLimit } from "@/lib/transfer/depositMax";
import { appendTransfer, removeTransfer } from "@/lib/transfer/history";
import { normalizeAmountInput } from "@/lib/transfer/numberInput";
import { sharesListedSymbol } from "@/lib/transfer/assets";
import { useTransferAssets } from "@/lib/transfer/useTransferAssets";
import { describeWithdrawFailure } from "@/lib/transfer/withdrawError";
import { assetPaysGas, buildWithdrawRpc, validateWithdraw, type TransferAsset } from "@/lib/transfer/withdrawForm";
import { AssetList, UnreviewedPill, assetKey } from "./AssetList";
import { RecipientField } from "./RecipientField";
import { TransferHistory } from "./TransferHistory";
import { TransferResult } from "./TransferResult";
import { BalanceError, Card, Notice, StepHeading, TransferShell } from "./TransferShell";

const rate = createRateAdapter();

interface Preview {
  /** Frozen with the rest: a preview made by one account is never shown to, or signed by, another. */
  from: Address;
  chainId: number;
  asset: TransferAsset;
  amount: bigint;
  amountText: string;
  recipient: Address;
}

export function WithdrawPanel() {
  const [chainId, setChainId] = useState<number>(appChains[0].id);
  const chain = appChains.find((c) => c.id === chainId)!;
  const { address, isConnected } = useWalletAccount();
  const { open, ready } = useWalletConnect();
  const customTokens = useCustomTokens(chainId, address);
  const { assets, isLoading, isError, refetch } = useTransferAssets(chainId, address, customTokens);
  const gasPrice = useGasPrice({ chainId, query: { refetchInterval: 15_000 } });

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [recipient, setRecipient] = useState("");
  const [touched, setTouched] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [sent, setSent] = useState<{ hash: Hex; summary: string } | null>(null);

  const selected = assets.find((a) => assetKey(a) === selectedKey) ?? null;

  // The most that can leave once the fee is reserved. Only an asset that ALSO pays gas
  // (the native asset, or USDC on Arc) needs a reserve; see lib/transfer/depositMax.
  const max = selected
    ? maxDepositable({
        held: selected.held,
        paysGas: assetPaysGas(selected, chain.nativeCurrency.symbol),
        gasPrice: gasPrice.data ?? null,
        gasLimit: transferGasLimit(selected.token !== "native"),
        nativeDecimals: chain.nativeCurrency.decimals,
        assetDecimals: selected.decimals,
      })
    : 0n;

  // Without a gas price no fee can be reserved for an asset that pays its own gas, and a zero
  // reserve would make "Max" the whole balance, which then cannot pay for its own transfer.
  const paysGas = selected ? assetPaysGas(selected, chain.nativeCurrency.symbol) : false;
  const feeKnown = !paysGas || gasPrice.data !== undefined;

  const check = validateWithdraw({ asset: selected, amount, recipient, from: address, max, feeKnown });

  // A preview is only ever live for the account and chain it was made on.
  const live = preview && address && preview.from.toLowerCase() === address.toLowerCase() && preview.chainId === chainId ? preview : null;
  // Stable identity: a new object each render would re-present the frame and wipe any error it is showing.
  const rpc = useMemo(() => (live ? buildWithdrawRpc({ asset: live.asset, amount: live.amount, recipient: live.recipient, from: live.from }) : null), [live]);
  const forgetReverted = useCallback((hash: Hex) => removeTransfer(hash), []);
  const fieldError = (field: "asset" | "amount" | "recipient") => (touched && !check.ok && check.field === field ? check.message : null);

  function reset() {
    setAmount("");
    setRecipient("");
    setTouched(false);
    setPreview(null);
    setFailure(null);
  }

  return (
    <TransferShell
      active="withdraw"
      chainId={chainId}
      onChainChange={(next) => {
        setChainId(next);
        setSelectedKey(null);
        setSent(null);
        reset();
      }}
    >
      {!isConnected || !address ? (
        <Card title="Connect to withdraw">
          <p className="text-sm text-[color:var(--m-text-secondary)]">Withdrawals are signed by your passkey wallet. Connect it first.</p>
          <button type="button" data-testid="withdraw-connect" disabled={!ready} onClick={open} className="min-h-11 self-start rounded-xl bg-[color:var(--m-primary)] px-5 text-sm font-semibold text-[color:var(--m-on-primary)] hover:bg-[color:var(--m-primary-hover)] disabled:opacity-60">
            Continue with passkey
          </button>
        </Card>
      ) : sent ? (
        <TransferResult
          hash={sent.hash}
          chainId={chainId}
          summary={sent.summary}
          onReverted={forgetReverted}
          onDone={() => {
            setSent(null);
            reset();
            refetch();
          }}
        />
      ) : live ? (
        <>
          <Card>
            <StepHeading>Check this transfer</StepHeading>
            <div className="flex flex-col items-center gap-1 py-2">
              <span className="text-[13px] text-[color:var(--m-text-secondary)]">You are sending</span>
              <span data-testid="withdraw-preview-amount" className="font-dm-mono text-4xl font-medium tracking-tight">
                {live.amountText} {live.asset.symbol}
              </span>
              {live.asset.trust === "unreviewed" && <UnreviewedPill />}
              {sharesListedSymbol(live.asset, rate.tokens(chainId)) && (
                <p data-testid="withdraw-preview-lookalike" className="text-center text-[13px] font-medium text-[color:var(--m-warning-700)] dark:text-[color:var(--m-warning-300)]">
                  This is not the {live.asset.symbol} on the reviewed list.
                </p>
              )}
            </div>
            <dl className="flex flex-col gap-2 text-[13px]">
              <div className="flex flex-col gap-1">
                <dt className="text-[color:var(--m-text-secondary)]">To</dt>
                <dd data-testid="withdraw-preview-recipient" className="break-all font-dm-mono">
                  {live.recipient}
                </dd>
              </div>
              {live.asset.trust === "unreviewed" && live.asset.token !== "native" && (
                <div className="flex flex-col gap-1">
                  <dt className="text-[color:var(--m-text-secondary)]">Token contract</dt>
                  <dd data-testid="withdraw-preview-contract" className="break-all font-dm-mono">
                    {getAddress(live.asset.token)}
                  </dd>
                </div>
              )}
              <div className="flex justify-between gap-4">
                <dt className="text-[color:var(--m-text-secondary)]">Network</dt>
                <dd>{chain.name}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-[color:var(--m-text-secondary)]">Balance after, before the network fee</dt>
                <dd className="font-dm-mono">
                  {formatUnits(live.asset.held - live.amount, live.asset.decimals)} {live.asset.symbol}
                </dd>
              </div>
            </dl>
          </Card>
          <Notice tone="warning">
            <strong>This cannot be undone.</strong> Onchain transfers are final. Check every character of the address and the network before you confirm.
          </Notice>
          {failure && <Notice tone="error">{failure}</Notice>}
          <Card>
            <p className="text-[13px] text-[color:var(--m-text-secondary)]">Transfers always ask. The button below is drawn by your wallet, which reads the transaction itself.</p>
            <WalletConfirmFrame
              chainId={chainId}
              rpc={rpc}
              label="Confirm transfer"
              variant="modal"
              onSubmitted={(hash) => {
                appendTransfer({ hash, kind: "withdraw", chainId, symbol: live.asset.symbol, amount: live.amountText, peer: live.recipient, at: Date.now() });
                setSent({ hash, summary: `Sent ${live.amountText} ${live.asset.symbol} on ${chain.name}` });
                setPreview(null);
              }}
              onFailed={(error) => setFailure(describeWithdrawFailure(error, { gasSymbol: chain.nativeCurrency.symbol }))}
            />
          </Card>
          <button type="button" data-testid="withdraw-back" onClick={() => setPreview(null)} className="min-h-11 self-start rounded-xl px-4 text-sm font-semibold hover:bg-[color:var(--m-surface-2)]">
            Back to edit
          </button>
        </>
      ) : (
        <>
          <Card>
            <StepHeading>1. Choose what to send</StepHeading>
            <AssetList assets={assets} selected={selectedKey} onSelect={(a) => setSelectedKey(assetKey(a))} isLoading={isLoading} />
            {isError && <BalanceError chainName={chain.name} onRetry={refetch} />}
            {fieldError("asset") && <p className="text-[13px] text-[color:var(--m-error-fg)]">{fieldError("asset")}</p>}
          </Card>

          <Card title="2. Amount and recipient">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="withdraw-amount" className="text-[13px] font-medium">
                Amount{selected ? ` in ${selected.symbol}` : ""}
              </label>
              <div className="flex gap-2">
                <input
                  id="withdraw-amount"
                  data-testid="withdraw-amount"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="0.00"
                  value={amount}
                  aria-invalid={fieldError("amount") !== null}
                  aria-describedby={fieldError("amount") ? "withdraw-amount-error" : undefined}
                  onChange={(e) => setAmount(normalizeAmountInput(e.target.value))}
                  className="h-11 min-w-0 flex-1 rounded-xl border border-[color:var(--m-border)] bg-[color:var(--m-background)] px-3 font-dm-mono text-sm aria-[invalid=true]:border-[color:var(--m-error)]"
                />
                <button type="button" data-testid="withdraw-max" disabled={!selected || max === 0n || !feeKnown} onClick={() => selected && setAmount(formatUnits(max, selected.decimals))} className="min-h-11 rounded-xl border border-[color:var(--m-border)] px-4 text-sm font-semibold hover:bg-[color:var(--m-surface-2)] disabled:cursor-not-allowed disabled:opacity-60">
                  Max
                </button>
              </div>
              {selected && !feeKnown && (
                <p data-testid="withdraw-fee-unknown" role="status" className="text-[13px] text-[color:var(--m-text-secondary)]">
                  {gasPrice.isError ? "The network fee could not be read, so Max and Preview are off. " : "Reading the network fee… "}
                  {gasPrice.isError && (
                    <button type="button" onClick={() => void gasPrice.refetch()} className="min-h-11 font-semibold underline underline-offset-2">
                      Try again
                    </button>
                  )}
                </p>
              )}
              {fieldError("amount") && (
                <p id="withdraw-amount-error" data-testid="withdraw-amount-error" role="alert" className="text-[13px] text-[color:var(--m-error-fg)]">
                  {fieldError("amount")}
                </p>
              )}
            </div>
            <RecipientField value={recipient} onChange={setRecipient} error={fieldError("recipient")} />
          </Card>

          <button
            type="button"
            data-testid="withdraw-preview"
            onClick={() => {
              setTouched(true);
              setFailure(null);
              if (check.ok && selected && address) setPreview({ from: address, chainId, asset: selected, amount: check.amount, amountText: formatUnits(check.amount, selected.decimals), recipient: check.recipient });
            }}
            className="min-h-12 rounded-2xl bg-[color:var(--m-primary)] text-sm font-semibold text-[color:var(--m-on-primary)] hover:bg-[color:var(--m-primary-hover)]"
          >
            Preview
          </button>

          <TransferHistory chainId={chainId} />
        </>
      )}
    </TransferShell>
  );
}
