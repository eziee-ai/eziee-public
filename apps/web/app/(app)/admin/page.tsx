import { PaymentTokensAdmin } from "@/components/admin/PaymentTokensAdmin";

export default function AdminPage() {
  return (
    <main className="mx-auto flex w-full max-w-[760px] flex-col gap-5 px-4 py-8">
      <div className="flex flex-col gap-2">
        <span className="font-dm-mono text-[10px] uppercase tracking-[0.18em] text-[color:var(--m-primary-fg)]">Operator</span>
        <h1 className="text-3xl font-black tracking-[-0.055em]">Admin</h1>
        <p className="max-w-[560px] text-[15px] leading-7 text-[color:var(--m-text-secondary)]">Tokens people can pay for credit with, besides USDC, and what one token buys.</p>
      </div>
      <PaymentTokensAdmin />
    </main>
  );
}
