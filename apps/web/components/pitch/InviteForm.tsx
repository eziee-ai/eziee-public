"use client";

import { useState, type FormEvent } from "react";
import { ArrowUpRight, Check, Loader2 } from "lucide-react";
import s from "./landing.module.css";

export function InviteForm({ id, autoFocus = false }: { id: string; autoFocus?: boolean }) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "pending" | "success">("idle");
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state === "pending") return;
    const website = new FormData(event.currentTarget).get("website");
    setState("pending");
    setError("");
    try {
      const response = await fetch("/api/waitlist", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, website }), signal: AbortSignal.timeout(20_000),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "We couldn’t save your request. Please try again.");
      setState("success");
    } catch (cause) {
      setState("idle");
      setError(cause instanceof Error && cause.name !== "TimeoutError" ? cause.message : "Connection timed out. Please try again.");
    }
  }

  if (state === "success") return <div className={s.inviteSuccess} role="status"><span><Check aria-hidden="true" /></span><h3>You’re on the list.</h3><p>We’ve saved your email. We’ll email you when your invite is ready.</p></div>;

  return <form className={s.inviteForm} onSubmit={submit} aria-busy={state === "pending"}>
    <label htmlFor={id}>Email address</label>
    <input id={id} type="email" name="email" autoComplete="email" placeholder="you@example.com" required maxLength={254} autoFocus={autoFocus} value={email} onChange={(event) => setEmail(event.target.value)} aria-describedby={`${id}-status`} disabled={state === "pending"} />
    <div className={s.honeypot} aria-hidden="true"><label>Website<input name="website" tabIndex={-1} autoComplete="off" /></label></div>
    <button type="submit" disabled={state === "pending"}>{state === "pending" ? <>Saving your spot <Loader2 className={s.spinner} /></> : <>Request an invite <ArrowUpRight /></>}</button>
    <p id={`${id}-status`} role={error ? "alert" : undefined}>{error || "Only updates about your eziee invite. No spam."}</p>
  </form>;
}
