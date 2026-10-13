"use client";

import { useSyncExternalStore } from "react";
import { recentRecipients, subscribeTransfers, transfersServerSnapshot, transfersSnapshot } from "@/lib/transfer/history";

/** The recipient input, with addresses this device has sent to before. Every address is shown in full. */
export function RecipientField({ value, onChange, error }: { value: string; onChange: (value: string) => void; error: string | null }) {
  const log = useSyncExternalStore(subscribeTransfers, transfersSnapshot, transfersServerSnapshot);
  const recents = recentRecipients(log);

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor="withdraw-recipient" className="text-[13px] font-medium">
        Send to
      </label>
      <input
        id="withdraw-recipient"
        data-testid="withdraw-recipient"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        placeholder="0x followed by 40 characters"
        value={value}
        aria-invalid={error !== null}
        aria-describedby={error ? "withdraw-recipient-error" : undefined}
        onChange={(e) => onChange(e.target.value)}
        className="h-11 rounded-xl border border-[color:var(--m-border)] bg-[color:var(--m-background)] px-3 font-dm-mono text-[13px] aria-[invalid=true]:border-[color:var(--m-error)]"
      />
      {error && (
        <p id="withdraw-recipient-error" data-testid="withdraw-recipient-error" role="alert" className="text-[13px] text-[color:var(--m-error-fg)]">
          {error}
        </p>
      )}
      {recents.length > 0 && (
        <div className="flex flex-col gap-1.5 pt-1">
          <span className="text-xs text-[color:var(--m-text-secondary)]">Sent to before, on this device</span>
          {recents.map((address) => (
            <button key={address} type="button" onClick={() => onChange(address)} className="min-h-11 break-all rounded-xl border border-[color:var(--m-border)] px-3 text-left font-dm-mono text-xs hover:bg-[color:var(--m-surface-2)]">
              {address}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
