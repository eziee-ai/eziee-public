import { CreditPanel } from "@/components/billing/CreditPanel";

export default function CreditPage() {
  return (
    <main className="mx-auto flex w-full max-w-[760px] flex-col gap-5 px-4 py-8">
      <div className="flex flex-col gap-2">
        <span className="font-dm-mono text-[10px] uppercase tracking-[0.18em] text-[color:var(--m-primary-fg)]">Usage credit</span>
        <h1 className="text-3xl font-black tracking-[-0.055em]">Credit</h1>
        <p className="max-w-[560px] text-[15px] leading-7 text-[color:var(--m-text-secondary)]">The model costs money each time it answers. You pay for that from credit held under your wallet address, and every reply shows what it cost.</p>
      </div>
      <CreditPanel />
    </main>
  );
}
