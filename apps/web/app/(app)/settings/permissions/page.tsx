import { WalletRulesFrame } from "@/components/wallet/WalletRulesFrame";

const ALWAYS_ASKS = [
  "Sending ETH, USDC or any token to an address",
  "Approvals to a spender no protocol registered, or larger than a rule allows",
  "Typed-data signatures and any message that is not this app's sign-in",
  "Calls to contracts no protocol registered",
  "Anything the wallet cannot decode with certainty",
];

export default function PermissionsPage() {
  return (
    <main className="mx-auto flex w-full max-w-[760px] flex-col gap-5 px-4 py-8">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Permissions</h1>
        <p className="text-[15px] text-[color:var(--m-text-secondary)]">Rules let the agent sign matching actions without asking. They are stored and enforced inside your wallet, on this device. This app, its server and the model cannot add or change them.</p>
      </div>

      <section className="flex flex-col gap-3.5 rounded-2xl border border-[color:var(--m-border)] bg-[color:var(--m-surface)] p-5">
        <h2 className="text-[15px] font-semibold">Saved rules on this device</h2>
        <WalletRulesFrame />
      </section>

      <section className="flex flex-col gap-3 rounded-2xl border border-[color:var(--m-border)] bg-[color:var(--m-surface)] p-5">
        <h2 className="text-[15px] font-semibold">These always ask, whatever rules exist</h2>
        <ul className="flex flex-col gap-2 text-sm">
          {ALWAYS_ASKS.map((item) => (
            <li key={item} className="flex gap-2.5">
              <span aria-hidden className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--m-warning)]" />
              {item}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
