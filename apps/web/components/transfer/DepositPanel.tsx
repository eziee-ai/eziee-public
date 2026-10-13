"use client";

import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { Hex } from "viem";
import { useWalletAccount, useWalletConnect } from "@repo/wallet";
import { appChains } from "@/lib/chains";
import { copyText } from "@/lib/transfer/clipboard";
import { connectWallet, discoverWallets, FUNDING_STEP_LABEL, isUserRejection, preflightFunding, sendFunding, type DiscoveredWallet, type FundingStep } from "@/lib/transfer/externalFunding";
import { faucetFor } from "@/lib/transfer/faucets";
import { depositUri } from "@/lib/transfer/gasDeposit";
import { appendTransfer } from "@/lib/transfer/history";
import { normalizeAmountInput } from "@/lib/transfer/numberInput";
import { useTransferAssets } from "@/lib/transfer/useTransferAssets";
import { validateAmount, type TransferAsset } from "@/lib/transfer/withdrawForm";
import { AssetList, assetKey } from "./AssetList";
import { TransferHistory } from "./TransferHistory";
import { TransferResult } from "./TransferResult";
import { BalanceError, Card, Notice, TransferShell } from "./TransferShell";

/** Stamped here, outside the component: the clock is read when the deposit is sent, never during a render. */
function recordDeposit(entry: { hash: Hex; chainId: number; symbol: string; amount: string; peer: string }): void {
  appendTransfer({ ...entry, kind: "deposit", at: Date.now() });
}

function useQr(uri: string | null): string | null {
  const [state, setState] = useState<{ uri: string; dataUrl: string } | null>(null);
  useEffect(() => {
    if (!uri) return;
    let cancelled = false;
    // Black on white on purpose, in both themes: scanners read contrast, not brand colours.
    QRCode.toDataURL(uri, { margin: 1, width: 352, color: { dark: "#000000", light: "#FFFFFF" } })
      .then((dataUrl) => {
        if (!cancelled) setState({ uri, dataUrl });
      })
      .catch(() => {
        if (!cancelled) setState(null);
      });
    return () => {
      cancelled = true;
    };
  }, [uri]);
  return state && state.uri === uri ? state.dataUrl : null;
}

export function DepositPanel() {
  const [chainId, setChainId] = useState<number>(appChains[0].id);
  const chain = appChains.find((c) => c.id === chainId)!;
  const { address, isConnected } = useWalletAccount();
  const { open, ready } = useWalletConnect();
  const { assets, isLoading, isError, refetch } = useTransferAssets(chainId, address);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selected: TransferAsset | undefined = assets.find((a) => assetKey(a) === selectedKey) ?? assets[0];
  const qr = useQr(address ? depositUri(address, chainId) : null);

  const [amount, setAmount] = useState("");
  const [step, setStep] = useState<FundingStep | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [sent, setSent] = useState<Hex | null>(null);

  const faucet = faucetFor(chain);

  const [choices, setChoices] = useState<DiscoveredWallet[] | null>(null);

  async function fundFromBrowserWallet(chosen?: DiscoveredWallet) {
    if (!address || !selected) return;
    setFailure(null);
    // Same strictness as a withdrawal: a deposit is just as irreversible for the wallet sending it.
    const parsed = validateAmount(amount, selected);
    if (!parsed.ok) return setFailure(parsed.message);
    try {
      setStep("connect");
      let wallet = chosen;
      if (!wallet) {
        const wallets = await discoverWallets();
        // More than one wallet: the user picks. Taking the first would prompt an arbitrary
        // extension and could sign from an account they did not mean to use.
        if (wallets.length > 1) return setChoices(wallets);
        wallet = wallets[0];
      }
      setChoices(null);
      await connectWallet(wallet);
      const token = selected.token === "native" ? undefined : { address: selected.token, decimals: selected.decimals, symbol: selected.symbol };
      const preflight = await preflightFunding({ chainId, amount: parsed.text, wallet, token });
      if (!preflight) throw new Error("The browser wallet did not share an account. Approve the connection in the wallet, then try again.");
      if (preflight.held < parsed.amount) throw new Error(`That wallet holds less ${selected.symbol} on ${chain.name} than this deposit.`);
      const hash = await sendFunding({ to: address, chainId, amount: parsed.text, account: preflight.account, wallet, token, needsSwitch: !preflight.onChain, onStep: setStep });
      recordDeposit({ hash, chainId, symbol: selected.symbol, amount: parsed.text, peer: preflight.account });
      setSent(hash);
      setAmount("");
    } catch (error) {
      // Closing the wallet's prompt is a decision, not a failure.
      if (!isUserRejection(error)) setFailure(error instanceof Error ? error.message : "The browser wallet could not send this deposit.");
    } finally {
      setStep(null);
    }
  }

  return (
    <TransferShell
      active="deposit"
      chainId={chainId}
      onChainChange={(next) => {
        setChainId(next);
        setSelectedKey(null);
        setSent(null);
        setFailure(null);
        setChoices(null);
      }}
    >
      {!isConnected || !address ? (
        <Card title="Connect to see your deposit address">
          <p className="text-sm text-[color:var(--m-text-secondary)]">Your wallet address is created from your passkey. Connect, and it appears here in full.</p>
          <button type="button" data-testid="deposit-connect" disabled={!ready} onClick={open} className="min-h-11 self-start rounded-xl bg-[color:var(--m-primary)] px-5 text-sm font-semibold text-[color:var(--m-on-primary)] hover:bg-[color:var(--m-primary-hover)] disabled:opacity-60">
            Continue with passkey
          </button>
        </Card>
      ) : sent ? (
        <TransferResult hash={sent} chainId={chainId} summary={`Deposit on ${chain.name}`} onDone={() => setSent(null)} />
      ) : (
        <>
          <Card title="1. Choose an asset">
            <AssetList assets={assets} selected={selected ? assetKey(selected) : null} onSelect={(a) => setSelectedKey(assetKey(a))} isLoading={isLoading} />
            {isError && <BalanceError chainName={chain.name} onRetry={refetch} />}
          </Card>

          <Card title={`2. Send ${selected?.symbol ?? "funds"} to your wallet`}>
            <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
              <div className="grid h-44 w-44 shrink-0 place-items-center overflow-hidden rounded-xl border border-[color:var(--m-border)] bg-white">
                {qr ? (
                  // eslint-disable-next-line @next/next/no-img-element -- a data: URL; next/image adds nothing and would need a loader
                  <img data-testid="deposit-qr" src={qr} alt={`QR code for your ${chain.name} address`} width={176} height={176} />
                ) : (
                  <span className="text-xs text-neutral-600">Preparing QR code</span>
                )}
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-2.5">
                <span className="text-[13px] text-[color:var(--m-text-secondary)]">Your wallet address, in full</span>
                {/* Never shortened: a shortened address cannot be checked and is not safe to send funds to. */}
                <code data-testid="deposit-address" className="break-all rounded-xl border border-[color:var(--m-border)] p-3 font-dm-mono text-sm">
                  {address}
                </code>
                <button
                  type="button"
                  data-testid="deposit-copy"
                  onClick={async () => ((await copyText(address)) ? toast.success("Address copied") : toast.error("Copy failed. Select the address and copy it by hand."))}
                  className="min-h-11 self-start rounded-xl border border-[color:var(--m-border)] px-4 text-sm font-semibold hover:bg-[color:var(--m-surface-2)]"
                >
                  Copy address
                </button>
              </div>
            </div>
            <Notice tone="warning">
              <strong>This network only.</strong> Send {selected?.symbol ?? "funds"} on {chain.name}. A deposit sent on any other network will not arrive here.
            </Notice>
          </Card>

          <Card title="Or deposit from a browser wallet">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="deposit-amount" className="text-[13px] font-medium">
                Amount in {selected?.symbol ?? "tokens"}
              </label>
              <input id="deposit-amount" inputMode="decimal" autoComplete="off" placeholder="0.00" value={amount} onChange={(e) => setAmount(normalizeAmountInput(e.target.value))} className="h-11 rounded-xl border border-[color:var(--m-border)] bg-[color:var(--m-background)] px-3 font-dm-mono text-sm" />
            </div>
            {failure && <Notice tone="error">{failure}</Notice>}
            {choices && (
              <div role="group" aria-label="Choose the wallet to deposit from" className="flex flex-col gap-2">
                <span className="text-[13px] font-medium">Choose the wallet to deposit from</span>
                {choices.map((wallet) => (
                  <button key={wallet.rdns} type="button" onClick={() => void fundFromBrowserWallet(wallet)} className="flex min-h-11 items-center gap-3 rounded-xl border border-[color:var(--m-border)] px-3 text-left text-sm font-medium hover:bg-[color:var(--m-surface-2)]">
                    {/* eslint-disable-next-line @next/next/no-img-element -- the wallet's own data: icon, announced over EIP-6963 */}
                    <img src={wallet.icon} alt="" width={20} height={20} />
                    {wallet.name}
                  </button>
                ))}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" disabled={step !== null || amount === "" || !selected} onClick={() => void fundFromBrowserWallet()} className="min-h-11 rounded-xl border border-[color:var(--m-border)] px-4 text-sm font-semibold hover:bg-[color:var(--m-surface-2)] disabled:cursor-not-allowed disabled:opacity-60">
                {step ? `${FUNDING_STEP_LABEL[step]}…` : "Deposit from a browser wallet"}
              </button>
              {faucet && (
                <a href={faucet} target="_blank" rel="noreferrer" className="flex min-h-11 items-center text-sm font-medium text-[color:var(--m-primary-fg)] underline underline-offset-2">
                  Get testnet funds
                </a>
              )}
            </div>
          </Card>

          <TransferHistory chainId={chainId} />
        </>
      )}
    </TransferShell>
  );
}
