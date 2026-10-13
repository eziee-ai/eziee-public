"use client";

import Link from "next/link";
import { ArrowDown, ArrowRight, ArrowUpRight, Check, Fingerprint, Moon, ShieldCheck, Sun, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import s from "./landing.module.css";
import { JevEvidence } from "./JevEvidence";
import type { JevEvidenceData } from "@/lib/jev-evidence";
import { InviteForm } from "./InviteForm";
import { OrderFlowBackdrop } from "./OrderFlowBackdrop";

function Logo() {
  return <span className={s.logo}><span className={s.glyph} aria-hidden><span>e</span><sup>✦</sup></span><span>eziee</span></span>;
}

export function LandingPage({ initialTheme = "light", evidence }: { initialTheme?: "light" | "dark"; evidence: JevEvidenceData }) {
  const [theme, setTheme] = useState(initialTheme);
  const [motion, setMotion] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const page = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setMotion(!preference.matches);
    update();
    preference.addEventListener("change", update);
    return () => preference.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!motion || !page.current) return;
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.setAttribute("data-visible", "true");
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12 });
    page.current.querySelectorAll("[data-reveal]").forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [motion]);


  return <div ref={page} className={s.page} data-theme={theme} data-motion={motion}>
    <a className={s.skip} href="#main">Skip to content</a>
    <header className={s.header}>
      <a href="#main" aria-label="eziee home"><Logo /></a>
      <nav aria-label="Main navigation" className={s.nav}>
        <a className={s.navSignIn} href="/home">Sign in</a>
        <button className={s.theme} type="button" onClick={() => setTheme(theme === "light" ? "dark" : "light")} aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}>{theme === "light" ? <Moon /> : <Sun />}</button>
        <button className={s.navCta} type="button" onClick={() => dialog.current?.showModal()}>Request an invite <ArrowUpRight /></button>
      </nav>
    </header>

    <dialog ref={dialog} className={s.inviteDialog} aria-labelledby="invite-title" onClick={(event) => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
      <div className={s.inviteDialogBody}>
        <button type="button" className={s.inviteClose} aria-label="Close invite form" onClick={() => dialog.current?.close()}><X /></button>
        <Logo />
        <h2 id="invite-title">Your next move.<br />Make it eziee.</h2>
        <p>Join the list for early access to your AI desk for onchain.</p>
        <InviteForm id="invite-email" autoFocus />
      </div>
    </dialog>
    <main id="main">
      <section className={s.hero} aria-labelledby="hero-title">
        <div className={s.backdrop}><OrderFlowBackdrop motion={motion} theme={theme} /></div>
        <div className={s.heroCopy}>
          {/* Your AI desk for onchain actions. */}
          <h1 id="hero-title">Onchain?<br /><span>GGEZ.</span></h1>
          <p className={s.heroDescription}>One intent.<br />Every step handled.</p>
          <button className={s.primary} type="button" onClick={() => dialog.current?.showModal()}>Request an invite <ArrowUpRight /></button>
        </div>
        {/* The artwork carries the protocol story; no duplicate slogan overlays. */}
      </section>

      <section id="how-it-works" className={s.story}>
        <div className={s.storyCopy} data-reveal>
          {/* You call the move. */}
          <h2>Your AI desk<br />for onchain.</h2>
          <p>Tell eziee what you want to do. It finds the route, prepares the action, and leaves the final approval to you.</p>
          <Link className={s.textLink} href="/home">Explore the desk <ArrowRight /></Link>
        </div>
        {/* A single action demonstrates the product without putting an app shell on the landing page. */}
        <div className={s.actionDemo} data-reveal>
          <div className={s.intent}>“Provide liquidity to the top APY pool.”<span>Your intent</span></div>
          <div className={s.intentLine}><span /><ArrowDown /><span /></div>
          <div className={s.action}>
            <div className={s.actionHeader}><span className={s.glyph} aria-hidden><span>e</span><sup>✦</sup></span><span>Ready for your review<small>Rate · Arc Testnet</small></span></div>
            <div className={s.swap}><strong>RATE / USDC</strong><ArrowRight /><strong>LP</strong></div>
            <dl><div><dt>Estimated fee APR</dt><dd>82.4%</dd></div><div><dt>Permission</dt><dd>You approve</dd></div></dl>
            <div className={s.review}><Check /> Your wallet. Your final say.</div>
          </div>
          <span className={s.demoCaption}>Illustrative preview</span>
        </div>
      </section>

      <section id="jev" className={s.engine}>
        {/* Powered by a different kind of AI. */}
        <div className={s.engineHeading} data-reveal><h2>More speed.<br />Less cost.</h2></div>
        <JevEvidence data={evidence} />
      </section>

      {/* Wallet safety follows the performance proof, then connections lead into the waitlist. */}
      <section className={s.walletStory} data-reveal>
        {/* The wallet runs locally on the visitor's device. */}
        <div><h2>Use Face ID.<br />Keep your wallet.</h2><p>eziee creates a wallet on your device. Face ID or your fingerprint unlocks it, while the wallet stays separate from other wallets and protocols. Nothing moves until you approve the transaction.</p><a className={s.textLink} href="https://monad.xyz/blog/introducing-mera" target="_blank" rel="noreferrer">How mera makes this possible <ArrowUpRight /></a></div>
        <div className={s.walletCard}>
          <div className={s.walletCardTop}><Fingerprint /><span>LOCAL PASSKEY WALLET<small>eziee · this device</small></span><ShieldCheck /></div>
          <div className={s.walletCardBody}><strong>Ready to approve</strong><span>Swap 100 USDC → EURC</span><button type="button"><Fingerprint /> Use Face ID / fingerprint</button></div>
          <small className={s.walletNote}>Passkey onboarding is part of the product direction. Transactions still require your explicit wallet approval.</small>
        </div>
      </section>

      {/* One desk. Open connections. */}
      <section className={s.connections} data-reveal><h2>Every protocol.<br />One simple desk.</h2><p>Use swaps, liquidity, lending, and staking from one place. eziee prepares each action and you approve it before anything moves.</p><div className={s.connectionLine}><span>Swap</span><span>Supply</span><span>Borrow</span><span>Stake</span><ArrowRight /><Logo /></div><small>More protocol connections are added over time.</small><div><a className={s.primary} href="https://cryptomcp.io" target="_blank" rel="noopener noreferrer">Browse MCPs <ArrowUpRight aria-hidden="true" /></a></div></section>

      <section id="waitlist" className={s.waitlist}>
        {/* Your next move. */}
        <div data-reveal><h2>Invite-only access.<br /><span>Make it eziee.</span></h2><p>Request an invite to the AI desk for onchain. We’re opening access in small groups.</p></div>
        <div data-reveal><InviteForm id="waitlist-email" /></div>
      </section>
    </main>
    <footer className={s.footer}><a href="#main" aria-label="eziee home"><Logo /></a><span>Onchain, made eziee.</span><Link href="/home">Open the desk <ArrowUpRight /></Link></footer>
  </div>;
}
