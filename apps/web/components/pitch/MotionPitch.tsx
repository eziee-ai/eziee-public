"use client";

import { ArrowLeft, ArrowRight, ArrowUpRight, Check, ChevronRight, Download, LockKeyhole, Pause, Play, RotateCcw, Search, ShieldCheck, Sun, Moon, Volume2, VolumeX } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";
import Link from "next/link";
import Image from "next/image";
import { BRAND } from "@repo/ui/brand";
import { CHAPTERS, DURATION, chapterAt, clamp, easeOut, progress } from "./timeline";
import { ThreeMotionBackdrop } from "./ThreeMotionBackdrop";
import s from "./pitch.module.css";

declare global {
  interface Window { __pitchRenderFrame?: (seconds: number) => void }
}

type Reveal = (delay?: number, distance?: number) => CSSProperties;

function Mark({ className = "" }: { className?: string }) {
  return <span aria-hidden className={`${s.mark} ${className}`}><ChevronRight /><ChevronRight /></span>;
}

function EzieeLogo() {
  return <span className={s.logoLockup} aria-label={BRAND}><span className={s.logoWord}><span>e</span><b>z</b><span>iee</span><sup>✦</sup></span></span>;
}

function WindowBar({ children, tone = "" }: { children: ReactNode; tone?: string }) {
  return <div className={`${s.windowBar} ${tone}`}><span>{children}</span><span aria-hidden className={s.windowControls}>− &nbsp; □ &nbsp; ×</span></div>;
}

function SceneHeading({ label, first, second, reveal }: { label: string; first: string; second: string; reveal: Reveal }) {
  return <div className={s.sceneHeading}>
    <div className={s.eyebrow} style={reveal(0.08)}>{label}</div>
    <h2><span style={reveal(0.16)}>{first}</span><span className={s.accentText} style={reveal(0.28)}>{second}</span></h2>
  </div>;
}

function Opening({ t, reveal, reduced }: { t: number; reveal: Reveal; reduced: boolean }) {
  return <div className={`${s.scene} ${s.opening}`}>
    <div className={s.mascotLayer} style={reveal(.35, 45)}><Image className={s.mascot} src="/pitch/desk-character-v3.png" width={1552} height={1012} priority alt="Anime DeFi desk operator in a gaming chair, reaching toward the viewer with a confident smile, with a black cat on her lap" /></div>
    <div className={s.eyebrow} style={reveal(0.05)}>Same chains. A smarter you.</div>
    <h2 className={s.massive}><span style={reveal(0.12, 70)}>Onchain?</span><span style={reveal(0.4, 70)}><span className={s.limeWord}>GGEZ.</span></span></h2>
    <span className={s.heroScribble}>GGEZ.</span>
    <div className={s.openingBottom} style={reveal(0.7)}><span>AN AI DESK FOR DEFI</span><span className={s.pinkSticker}>INTENT → ACTION</span></div>
    <div aria-hidden className={s.speedMarks} style={{ transform: `translateX(${reduced ? 0 : 24 * (1 - easeOut(progress(t, 0.5, 1.2)))}%)`, opacity: reduced ? 1 : easeOut(progress(t, 0.5)) }}><Mark /><Mark /><Mark /></div>
  </div>;
}

function Friction({ t, reveal, reduced }: { t: number; reveal: Reveal; reduced: boolean }) {
  const collapse = reduced ? 0 : easeOut(progress(t, 4.12, 0.72));
  return <div className={`${s.scene} ${s.friction}`}>
    <SceneHeading label="The friction" first="One intent." second="Too many tabs." reveal={reveal} />
    <div className={s.windowCollage}>
      <div className={`${s.floatingWindow} ${s.marketWindow}`} style={{ ...reveal(0.4, 70), transform: `translate(${collapse * 50}%, ${collapse * 28}%) rotate(${-7 * (1 - collapse)}deg) scale(${1 - collapse * 0.18})`, opacity: (reduced ? 1 : easeOut(progress(t, .4))) * (1 - collapse) }}>
        <WindowBar tone={s.cyanBar}>MARKET / 01</WindowBar><div className={s.floatingContent}><span className={s.micro}>Pool liquidity</span><svg viewBox="0 0 260 75" aria-hidden><path d="M0 66 22 53 43 61 65 33 84 40 106 27 124 42 146 18 168 28 190 9 210 24 236 5 260 16" fill="none" stroke="currentColor" strokeWidth="4" /></svg><div className={s.fakeRows}><i /><i /><i /></div></div>
      </div>
      <div className={`${s.floatingWindow} ${s.chatWindow}`} style={{ ...reveal(.6, 65), transform: `translateY(${-collapse * 12}%) rotate(${5 * (1 - collapse)}deg) scale(${1 - collapse * .1})`, opacity: (reduced ? 1 : easeOut(progress(t, .6))) * (1 - collapse) }}>
        <WindowBar tone={s.pinkBar}>ANOTHER EXPLANATION</WindowBar><div className={s.floatingContent}><span>Let’s walk through the options…</span><div className={s.fakeRows}><i /><i /><i /><i /><i /><i /></div><span className={s.typingDots}>•••</span></div>
      </div>
      <div className={`${s.floatingWindow} ${s.quoteWindow}`} style={{ ...reveal(.8, 60), transform: `translate(${-collapse * 50}%, ${-collapse * 28}%) rotate(${-3 * (1 - collapse)}deg) scale(${1 - collapse * .18})`, opacity: (reduced ? 1 : easeOut(progress(t, .8))) * (1 - collapse) }}>
        <WindowBar tone={s.limeBar}>PROTOCOL / 03</WindowBar><div className={s.floatingContent}><span className={s.micro}>You want to swap</span><strong>100 <small>USDC</small></strong><div className={s.quoteArrow}>↓</div><span className={s.fakeSelect}>Choose a route <ChevronRight /></span></div>
      </div>
    </div>
  </div>;
}

function Desk({ t, reveal, reduced }: { t: number; reveal: Reveal; reduced: boolean }) {
  const typed = reduced ? 1 : progress(t, 1.2, 1.05);
  const intent = "Swap 100 USDC to EURC.";
  const prepared = reduced || t > 3.2;
  return <div className={`${s.scene} ${s.deskScene}`}>
    <div className={s.deskTitle} style={reveal(.05)}><h2>Your next move. <span>One desk.</span></h2><span className={s.micro}>UI CONCEPT / ILLUSTRATIVE DATA</span></div>
    <div className={s.deskWindow} style={reveal(.24, 90)}>
      <WindowBar><span className={s.deskWindowName}><Mark /> {BRAND}</span><span className={s.micro}>YOUR DEFI WORKSPACE</span></WindowBar>
      <div className={s.deskBody}>
        <aside className={s.deskNav}><span className={s.navActive}>↗ &nbsp; Your desk</span><span><Search /> Markets</span><span>◫ &nbsp; Positions</span><span>⇅ &nbsp; Activity</span><div className={s.navBottom}><LockKeyhole /> Your wallet<br /><small>You control the keys.</small></div></aside>
        <div className={s.deskMain}>
          <div className={s.deskTop}><span>YOUR NEXT MOVE</span><span className={s.networkTag}>Arc Testnet</span></div>
          <div className={s.intentLine}><span className={s.avatar}>YOU</span><p>{intent.slice(0, Math.floor(intent.length * typed))}<span className={s.caret} aria-hidden /></p></div>
          <div className={s.preparedAction} style={reveal(3.2, 28)}>
            <div className={s.actionTop}><span className={s.actionIcon}><ArrowUpRight /></span><div><h3>Swap USDC → EURC</h3><span>Prepared on Rate · Arc Testnet</span></div><span className={s.reviewBadge}>Review</span></div>
            <div className={s.actionMetrics}><div><span>Spend cap</span><strong>100 <small>USDC</small></strong></div><div><span>Slippage limit</span><strong>0.5<small>%</small></strong></div><div><span>Permission</span><strong className={s.permissionText}>Ask first</strong></div></div>
            <div className={s.actionFooter}><span><ShieldCheck /> Wallet review required</span><span className={s.visualButton}>Review action <ArrowUpRight /></span></div>
          </div>
          <div className={s.deskComposer}><span>{prepared ? "What’s your next move?" : "Describe the outcome you want"}</span><div><span className={s.composerPill}>Protocols / Auto</span><span className={s.composerPill}>Decision engine / Jev · concept</span><span className={s.sendSquare}><ArrowUpRight /></span></div></div>
        </div>
      </div>
    </div>
  </div>;
}

function Decision({ t, reveal, reduced }: { t: number; reveal: Reveal; reduced: boolean }) {
  const line = reduced ? 1 : easeOut(progress(t, 1, 1.5));
  return <div className={`${s.scene} ${s.decisionScene}`}>
    <SceneHeading label="Jev / System One" first="State in." second="Decision out." reveal={reveal} />
    <div className={s.decisionFlow}>
      <div className={s.statePacket} style={reveal(.45)}><span className={s.micro}>PROTOCOL STATE</span><div>Intent <Check /></div><div>Market context <Check /></div><div>Wallet limits <Check /></div></div>
      <div className={s.flowConnector} aria-hidden><span style={{ transform: `scaleX(${line})` }} /><ArrowRight /></div>
      <div className={s.jevCore} style={reveal(.85, 40)}><span className={s.coreGlyph} aria-hidden>∴</span><strong>Jev</strong><span>Structured decisions</span><small>TypeSafe / System One</small></div>
      <div className={s.flowConnector} aria-hidden><span style={{ transform: `scaleX(${line})` }} /><ArrowRight /></div>
      <div className={s.decisionResult} style={reveal(2, 30)}><span className={s.micro}>BOUNDED OUTPUT</span><div><span>Action</span><b>Swap</b></div><div><span>Protocol</span><b>Rate</b></div><div><span>Spend cap</span><b>100 USDC</b></div><div><span>Approval</span><b>Required</b></div></div>
    </div>
    <p className={s.decisionStatement} style={reveal(2.65)}>Decisions software can use.<br /><span>Designed for the next action.</span></p>
    <div className={s.jevProof} style={reveal(3.05)}><div><strong>70–500ms</strong><span>reported response range</span></div><div><strong>40–200×</strong><span>faster on System One queries</span></div><div><strong>$0.042 / MTok</strong><span>reported input price</span></div><div><strong>more checks / budget</strong><span>parallel questions, free output</span></div></div>
    <span className={s.conceptNote}>Proposed Jev integration · illustrative decision</span>
  </div>;
}

function Connections({ t, reveal, reduced }: { t: number; reveal: Reveal; reduced: boolean }) {
  const linked = reduced ? 1 : easeOut(progress(t, .7, 1.5));
  return <div className={`${s.scene} ${s.connections}`}>
    <SceneHeading label="Protocol independent" first="One desk." second="Open connections." reveal={reveal} />
    <div className={s.connectionMap}>
      <svg className={s.connectionLines} viewBox="0 0 800 300" fill="none" aria-hidden><path d="M220 150H380V50H550M380 150H550M380 150V250H550" stroke="currentColor" strokeWidth="2" pathLength="1" strokeDasharray="1" strokeDashoffset={1 - linked} /><circle cx={220 + linked * 160} cy="150" r="5" fill="currentColor" /></svg>
      <div className={s.deskHub} style={reveal(.3)}><EzieeLogo /><span>Your intent. Your desk.</span></div>
      <div className={s.protocolNodes}>
        <div className={`${s.protocolNode} ${s.rateNode}`} style={reveal(1)}><span className={s.protocolSymbol}>i</span><div><strong>Rate</strong><span>Swap · orders · liquidity</span></div><span className={s.nodeTag}>AVAILABLE ADAPTER</span></div>
        <div className={`${s.protocolNode} ${s.futureNode}`} style={reveal(1.35)}><span className={s.protocolSymbol}>↗</span><div><strong>Lending MCP</strong><span>Future integration</span></div><span className={s.nodeTag}>CONCEPT</span></div>
        <div className={`${s.protocolNode} ${s.futureNode}`} style={reveal(1.7)}><span className={s.protocolSymbol}>⇄</span><div><strong>Bridge MCP</strong><span>Future integration</span></div><span className={s.nodeTag}>CONCEPT</span></div>
      </div>
    </div>
    <span className={s.conceptNote}>One workspace. A growing protocol ecosystem.</span>
  </div>;
}

function Control({ reveal }: { reveal: Reveal }) {
  return <div className={`${s.scene} ${s.controlScene}`}>
    <SceneHeading label="You stay in control" first="Fast decisions." second="Your permission." reveal={reveal} />
    <div className={s.controlCopy} style={reveal(.5)}><p>The desk prepares.<br />Your wallet checks.<br /><strong>You set the permissions.</strong></p><span className={s.controlStamp}><ShieldCheck /> KEYS STAY WITH YOU</span></div>
    <div className={s.walletReview} style={reveal(.7, 70)}><div className={s.walletTitle}><span><ShieldCheck /> WALLET REVIEW</span><LockKeyhole /></div><h3>Review swap</h3><p>Rate · Arc Testnet</p><div className={s.walletAmount}>100 <span>USDC</span><ArrowRight /><span>EURC</span></div><div className={s.walletDetail}><span>Maximum spend</span><b>100 USDC</b></div><div className={s.walletDetail}><span>Slippage limit</span><b>0.5%</b></div><div className={s.walletDetail}><span>Permission</span><b>Allow once</b></div><div className={s.walletCheck}><Check /> Protocol and limits checked</div><div className={s.walletButtons}><span>Deny</span><span>Allow once <ArrowUpRight /></span></div><small>Illustrative review · nothing is signed</small></div>
  </div>;
}

function Closing({ reveal }: { reveal: Reveal }) {
  return <div className={`${s.scene} ${s.closing}`}>
    <div className={s.closingBrand} style={reveal(.1)}><EzieeLogo /></div>
    <h2 className={s.massive}><span style={reveal(.18, 60)}>Your intent.</span><span style={reveal(.38, 60)}>Into action.</span></h2>
    <div className={s.closingBottom} style={reveal(.75)}><span>AN AI DESK FOR ONCHAIN.</span><a className={s.waitlistCta} href="#waitlist">REQUEST AN INVITE <ArrowUpRight /></a><span className={s.closingArrow} aria-hidden>↗</span></div>
    <div className={s.closingSteps} style={reveal(1.1)}><span>INTENT</span><ArrowRight /><span>DECISION</span><ArrowRight /><span>ACTION</span></div>
  </div>;
}

export function MotionPitch() {
  const [time, setTime] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [sound, setSound] = useState(false);
  const [soundError, setSoundError] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [waitlistEmail, setWaitlistEmail] = useState("");
  const [waitlistJoined, setWaitlistJoined] = useState(false);
  const [rendering] = useState(() => typeof window !== "undefined" && new URLSearchParams(window.location.search).has("render"));
  const [theme, setTheme] = useState<"dark" | "light">(() => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("theme") === "dark" ? "dark" : "light");
  const timeRef = useRef(1);
  const started = useRef(false);
  const audio = useRef<HTMLAudioElement>(null);
  const index = Math.max(0, chapterAt(time));
  const chapter = CHAPTERS[index]!;
  const local = time - chapter.start;

  const seek = useCallback((seconds: number) => {
    const next = clamp(seconds, 0, DURATION);
    timeRef.current = next;
    setTime(next);
    if (audio.current) audio.current.currentTime = next;
  }, []);

  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => { setReduced(preference.matches); if (preference.matches) setPlaying(false); };
    update();
    preference.addEventListener("change", update);
    const visibility = () => { if (document.hidden) setPlaying(false); };
    document.addEventListener("visibilitychange", visibility);
    if (rendering) {
      window.__pitchRenderFrame = (seconds) => {
        timeRef.current = clamp(seconds, 0, DURATION);
        flushSync(() => { setTime(timeRef.current); setPlaying(false); });
      };
    }
    return () => {
      preference.removeEventListener("change", update);
      document.removeEventListener("visibilitychange", visibility);
      delete window.__pitchRenderFrame;
    };
  }, [rendering]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const next = Math.min(DURATION, timeRef.current + Math.min((now - last) / 1000, .1));
      last = now;
      timeRef.current = next;
      setTime(next);
      if (next >= DURATION) setPlaying(false);
      else frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  useEffect(() => {
    const element = audio.current;
    if (!element) return;
    if (playing && sound) {
      element.currentTime = timeRef.current;
      void element.play().catch(() => { setSoundError(true); setSound(false); });
    } else element.pause();
  }, [playing, sound]);

  const togglePlay = () => {
    if (!started.current || timeRef.current >= DURATION) { seek(0); started.current = true; }
    setPlaying((value) => !value);
  };
  const jump = (next: number) => { seek(CHAPTERS[clamp(next, 0, CHAPTERS.length - 1)]!.start + (reduced ? 1 : .75)); };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.target instanceof HTMLElement && /^(INPUT|BUTTON|A)$/.test(event.target.tagName)) return;
    if (event.key === " ") { event.preventDefault(); togglePlay(); }
    if (event.key === "ArrowRight") { event.preventDefault(); jump(index + 1); }
    if (event.key === "ArrowLeft") { event.preventDefault(); jump(index - 1); }
    if (event.key === "Home") { event.preventDefault(); seek(1); setPlaying(false); }
  };
  const reveal: Reveal = (delay = 0, distance = 28) => {
    const amount = reduced ? 1 : easeOut(progress(local, delay));
    return { opacity: amount, transform: `translateY(${(1 - amount) * distance}px)` };
  };
  const scenes = [<Opening key="idea" t={local} reveal={reveal} reduced={reduced} />, <Friction key="friction" t={local} reveal={reveal} reduced={reduced} />, <Desk key="desk" t={local} reveal={reveal} reduced={reduced} />, <Decision key="decision" t={local} reveal={reveal} reduced={reduced} />, <Connections key="connections" t={local} reveal={reveal} reduced={reduced} />, <Control key="control" reveal={reveal} />, <Closing key="close" reveal={reveal} />];

  return <main className={`${s.page} ${rendering ? s.renderPage : ""}`} onKeyDown={onKeyDown}>
    <header className={s.pageHeader}><Link href="/" className={s.brandLink}><EzieeLogo /></Link><nav className={s.pitchNav} aria-label="Landing page"><a href="#waitlist">Request an invite</a><Link href="/home" className={s.deskLink}>Sign in <ArrowUpRight /></Link><button type="button" className={s.themeButton} onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label={theme === "dark" ? "Show light pitch" : "Show dark pitch"}>{theme === "dark" ? <Sun /> : <Moon />}{theme === "dark" ? "Light" : "Dark"}</button></nav></header>
    <section className={s.player} aria-label="Product film player" tabIndex={0}>
      <div className={`${s.stage} ${index === 6 ? s.limeStage : ""}`} data-testid="pitch-stage" data-chapter={index}>
        <ThreeMotionBackdrop theme={theme} />
        {/* The logo already identifies the product; keep the frame label functional and quiet. */}
        <div className={s.filmTop}><span aria-hidden /> <span>PRODUCT CONCEPT</span></div>
        {scenes[index]}
        <div className={s.filmBottom}><span>{String(index + 1).padStart(2, "0")} / 07</span><p>{chapter.caption}</p><Mark /></div>
      </div>
      <div className={s.transport}>
        <button className={s.playButton} type="button" onClick={togglePlay} aria-label={playing ? "Pause pitch" : time >= DURATION ? "Replay pitch" : "Play pitch"}>{playing ? <Pause /> : <Play />}<span>{playing ? "Pause" : time >= DURATION ? "Replay film" : "Play film"}</span></button>
        <button className={s.iconButton} type="button" aria-label="Restart pitch" onClick={() => { started.current = true; seek(0); setPlaying(true); }}><RotateCcw /></button>
        <label className={s.scrubber}><span className={s.srOnly}>Pitch timeline</span><input type="range" min="0" max={DURATION} step="0.05" value={time} aria-valuetext={`${Math.floor(time)} seconds: ${chapter.label}`} onChange={(event) => seek(Number(event.target.value))} style={{ "--progress": `${time / DURATION * 100}%` } as CSSProperties} /></label>
        <span className={s.timecode}>00:{String(Math.floor(time)).padStart(2, "0")} <span>/ 00:42</span></span>
        <button className={s.iconButton} type="button" aria-label={sound ? "Mute soundtrack" : "Enable soundtrack"} aria-pressed={sound} onClick={() => { setSoundError(false); setSound((value) => !value); }}>{sound ? <Volume2 /> : <VolumeX />}</button>
        <a className={s.iconButton} href={theme === "dark" ? "/pitch/eziee-pitch.mp4" : "/pitch/eziee-pitch-light.mp4"} download aria-label={`Download ${theme} pitch as MP4`}><Download /></a>
      </div>
      <nav className={s.chapters} aria-label="Pitch chapters">{CHAPTERS.map((item, i) => <button key={item.start} type="button" aria-current={i === index ? "step" : undefined} onClick={() => { started.current = true; jump(i); }}><span>{String(i + 1).padStart(2, "0")}</span>{item.label}</button>)}</nav>
    </section>
    <section className={s.pitchNotes} id="waitlist">
      <div><span className={s.eyebrow}>THE IDEA, IN 42 SECONDS</span><h1>Your intent. Into action.</h1><p>A desk that turns what you want to do into a clear protocol action. Jev is the intended decision layer: TypeSafe describes typed outputs sampled in parallel instead of a long string generated token by token. TypeSafe reports 70–500ms end to end, 40–200× faster System One shaped queries, $0.042 per million input tokens, and free output. That cost and parallel shape make more bounded checks practical inside one onchain workflow. Rate is one of the connections.</p></div>
      <div className={s.pitchAside}><span className={s.conceptPill}>INVITE-ONLY ACCESS</span><p>The film uses illustrative UI. Jev and additional MCP integrations are proposed; the Rate adapter and wallet approval flow already exist.</p><form className={s.waitlistForm} onSubmit={(event) => { event.preventDefault(); if (waitlistEmail.trim()) setWaitlistJoined(true); }}><label htmlFor="pitch-waitlist-email">Request an invite</label>{waitlistJoined ? <p className={s.waitlistSuccess} role="status">Request received. We’ll send the next build when your invite is ready.</p> : <div><input id="pitch-waitlist-email" type="email" required value={waitlistEmail} onChange={(event) => setWaitlistEmail(event.target.value)} placeholder="you@example.com" autoComplete="email" /><button type="submit">Request invite <ArrowUpRight /></button></div>}</form><div className={s.sources}><a href="https://typesafe.ai/blog/introducing-system-one-models-and-jev" target="_blank" rel="noreferrer">About Jev <ArrowUpRight /></a><a href="https://www.youtube.com/watch?v=kgAVoL49H3M" target="_blank" rel="noreferrer">GGEZ inspiration <ArrowUpRight /></a></div></div>
    </section>
    <div className={s.accessibilityNote}>{reduced ? "Reduced motion is on. Use the chapters to read the pitch at your pace." : "Space to play / pause. Arrow keys to change chapters. Original soundtrack available."}{soundError && <span role="status"> Sound could not play. The film works without audio.</span>}</div>
    <div className={s.mobileChapterControls}><button type="button" disabled={index === 0} onClick={() => jump(index - 1)}><ArrowLeft /> Previous</button><span>{chapter.label}</span><button type="button" disabled={index === CHAPTERS.length - 1} onClick={() => jump(index + 1)}>Next <ArrowRight /></button></div>
    <audio ref={audio} src="/pitch/pulse.wav" preload="none" />
  </main>;
}
