# Design

## Source of truth
- Status: Active direction; palette open to visual refinement.
- Last refreshed: 2026-09-20.
- Primary product surfaces: DeFi AI desk, protocol selection, action cards, transfers, wallet approvals, permissions.
- User direction: an independent AI desk for DeFi; Rate is one integration; Jev supplies fast structured decisions; GGEZ supplies aesthetic inspiration.
- Evidence reviewed: `packages/ui/src/tokens.css`, `packages/ui/src/brand.ts`, `apps/web/components/{shell,chat,transfer,wallet}`, `apps/web/lib/providers.tsx`, `packages/agent/src/models.ts`, `docs/superpowers/specs/2026-09-18-agentic-trading-chat-design.md`.
- References: [TypeSafe's Jev announcement](https://typesafe.ai/blog/introducing-system-one-models-and-jev), [GGEZ official video](https://www.youtube.com/watch?v=kgAVoL49H3M).
- Reference limits: the video page, thumbnail and YouTube storyboard frames were inspected; full playback failed. Visible frames show acid yellow, black/white typography, pink desktop-window graphics, cyan accents and cutout composition. Colors below are an original interpretation, not sampled brand specifications. Motion guidance is a design choice, not a measured video analysis.
- This document supersedes the old instruction to inherit Rate's visual language. Historical implementation plans describe the previous state.

## Landing page refinement — 2026-09-20
- `/` is a scrolling acquisition page (`/pitch` redirects here), with section entrance motion and a waitlist CTA. Playback controls and chapter pagination belong only to the optional film/export view.
- Default landing palette: cloud `#F7F8FA`, ink `#0B0B0F`, lime `#C6FF00`. A dark toggle remains available. This supersedes earlier dark-default and chalk guidance for the landing surface.
- First screen: “DeFi? GGEZ.”, anime operator and cat, `[glyph] eziee`, one early-access action. Keep the reading surface neutral; iridescence stays behind artwork at low opacity.
- ThreeUI is authorized for this marketing surface. Do not multiply a dark shader over the light page. Reduced-motion mode omits the shader and reveals all content without movement.
- Demonstrate a single protocol action inline; do not frame the landing page as a player or a complete app screenshot.
- The waitlist form currently saves only in this browser and reports that limitation after submission. A delivery service is still needed for online enrollment.

## Brand
- Product: **eziee**; descriptor: **AI desk for DeFi**.
- Personality: quick, assured, playful in identity, precise in execution.
- Positioning: turn intent into protocol actions across DeFi.
- Brand hierarchy: the desk owns the identity; Jev is the intended decision engine; protocols/MCPs, including Rate, are integrations. Neither provider sets the product palette.
- Trust signals: named protocol and chain, explicit amounts, fresh quotes, readable transaction previews, separate approval, real receipts.
- Avoid: Rate's muted blue/gold palette, generic AI purple gradients, robot avatars, long theatrical thinking animations, claims that speed or typed output guarantees profitable or correct decisions.

## Product goals
- Goals: make protocol discovery and action preparation feel immediate; show actionable results before optional explanation; keep signing under wallet policy.
- Non-goals for this brand change: replacing the chat transport, implementing the Jev service, adding protocol adapters, claiming measured end-to-end latency.
- Success signals: the desk is recognizable without a protocol logo; people can identify action, network, cost and approval state without reading an essay.
- Jev direction: use bounded typed decisions for routing, classification and scoring against protocol state; retain language models for interpreting open-ended requests and explaining results. The TypeSafe article describes general structured decision tasks, not a DeFi benchmark. Protocol optimization belongs in our schemas, context, evaluation and deterministic code.
- Current runtime: the checked-in model picker uses AI Gateway chat models. Jev integration is a product requirement, not a capability shipped by this visual change. Only show model confidence, provenance or timing when returned by the actual backend. Schema correctness does not establish economic correctness.

## Personas and jobs
- Primary personas: DeFi users managing assets across protocols; experienced users who prefer specifying an outcome to manually navigating protocol interfaces.
- Jobs: inspect markets/balances/positions, quote swaps, prepare orders, provide liquidity, review and authorize transactions.
- Context: desktop desk for sustained use; mobile for quick inspection and approval. Testnet/network identity must remain visible.

## Information architecture
- Primary navigation: new chat, history/search, deposit, withdraw, permissions, wallet, appearance.
- Routes: `/home`, `/c/[id]`, `/deposit`, `/withdraw`, `/settings/permissions`, isolated `/wallet-frame/*`.
- Content hierarchy: intent → result/action → protocol and chain → amounts/fees/constraints → approval → receipt; explanation is secondary.
- Protocols appear in the selector and action provenance. Homepage suggestions stay protocol-neutral. Only integrations present in the registry appear as available.

## Design principles
- Fast to read: short labels, concrete verbs, numbers in stable columns, explicit states.
- One primary action: lime marks the main control or active choice, never every surface.
- Personality at the edges: identity, empty state, illustrations and launch graphics can carry GGEZ energy; balances and approvals stay quiet.
- Tradeoff: financial readability takes precedence over collage, glitch, animation and decorative text distortion.

## Visual language

| Role | Value | Use |
|---|---|---|
| Acid lime | `#D7F43B` | Signature mark, primary button fills, dark-theme active ink |
| Ink | `#10120F` | Default dark canvas |
| Chalk | `#F3F4ED` | Dark-theme text / light canvas |
| Panel | `#181C16` | Dark raised surface |
| Panel raised | `#242A20` | Dark hover / grouped control surface |
| Signal cyan | `#55DCE0` | Secondary diagram/data accent, sparingly |
| Pop pink | `#F388CA` | Expressive brand graphics, sparingly |
| Lime ink | `#485A08` | Readable lime-family text/focus on light surfaces |

- Color: roughly 85% neutral, 10% lime, at most 5% cyan/pink combined in brand compositions. The working desk is more restrained. Green success, amber warning and warm red failure are semantic roles independent of the brand. Never use pink to mean a loss or lime to imply profit.
- Light mode: chalk `#F3F4ED`, almost-white panels `#FCFCF8`, dark ink `#171A14`. Bright lime buttons always use dark `#111310` labels. Link/focus ink is theme-aware.
- Typography: existing Satoshi variable for identity and UI; existing DM Mono for addresses, amounts, provenance and tiny utility labels. Large, tightly tracked headings; sentence case for financial operations. No distorted numbers.
- Spacing/layout: 4 px base rhythm; 280 px sidebar; 760 px conversation; 560 px transfer forms. Generous empty-state space, compact action details.
- Shape/radius/elevation: crisp flat fills, 1 px dividers, 8–16 px control radii, up to 20 px composer. No ambient glow or gradients behind financial content. Shadows only for overlays.
- Chat sky (owner request, 2026-10-04): the chat sits on an original painted anime sky (`apps/web/public/chat/sky.webp`) with a fine dot screen, faded into the page, dimmed in dark mode and stepped back once a conversation starts. It is a deliberate exception to "no gradients behind financial content"; the composer and suggestions sit on frosted glass (`.on-sky`). Static, no drift.
- Motion: functional color/opacity feedback, 120–180 ms; no decorative waiting before an available result. Continuous animation is reserved for actual pending work.
- Imagery/iconography: forward chevrons as a provisional desk mark, consistent line icons. Cutouts and desktop-window motifs belong in original brand artwork; do not reuse video footage or artists' likenesses in product assets.

## Components
- Reuse: `AppShell`, `Sidebar`, `PromptInput`, tool/result cards, transfer panels, wallet confirmation frames.
- Changed: independent shared palette, desk descriptor/empty state, neutral market suggestion, dark default and appearance switch, readable button/selection/focus colors.
- States: buttons use `--m-on-primary`; selected rows use the semantic selected pair, never a numbered ramp; success surfaces use the semantic success pair. Colored borders/focus use `--m-primary-fg`.
- Ownership: `packages/ui/src/tokens.css` is the color source; `packages/ui/src/brand.ts` holds product copy; `apps/web/app/globals.css` maps Tailwind/shadcn aliases. Keep the existing `--m-*` API so isolated wallet and app stay compatible.
- Visual review: `docs/brand/index.html` imports the real tokens and supports both themes. Any example decision data in this board is explicitly illustrative.

## Accessibility
- Target: WCAG 2.2 AA, including 4.5:1 body-text contrast and visible keyboard focus.
- Keyboard/focus: all actions are semantic controls; focus uses a 2 px theme-aware outline; dialogs retain their existing focus/escape behavior.
- Contrast/readability: text roles are measured against all application surfaces; selected/success/error/warning pairs are checked separately. Bright cyan/pink are graphics colors, not body-text colors on light surfaces.
- Screen readers: retain accessible names and status/error semantics; decorative marks are hidden. P&L retains signs and labels, never color alone.
- Reduced motion: no new animation dependency or decorative loop; future motion must respect reduced-motion preferences.

## Responsive behavior
- Supported: 360 px mobile through wide desktop.
- Adaptations: existing drawer below 768 px, wrapped composer controls/suggestions, fluid empty-state heading, vertically stacked action information where necessary.
- Touch/hover: approval targets stay at least 44 px; essential information never depends on hover.

## Interaction states
- Loading: say what is pending; distinguish model response, quote, wallet approval and chain confirmation.
- Empty: “Your intent. Into action.” with concrete available tasks and wallet connection.
- Error: name the failed stage and recovery; a failed balance read is not a zero balance.
- Success: actual receipt/result with provenance; no fabricated performance or profit claims.
- Disabled: explain the unmet prerequisite beside the control.
- Offline/slow network: preserve intent, surface unavailable data, never imply a timed-out transaction failed conclusively.

## Content voice
- Tone: concise, direct, confident without boasting.
- Terminology: desk, intent, action, protocol, quote, preview, approve, confirmed.
- Microcopy: use “Preview swap”, “Review order”, “Check balances”; reserve “confirmed” for confirmed results. Mention Rate when identifying the actual integration.
- Decision interfaces: show choice, probability/confidence if provided, constraints and source state. Never invent a reasoning paragraph to fill space.

## Implementation constraints
- Stack: Next.js App Router, React, Tailwind v4, shadcn/AI Elements, next-themes.
- Tokens: one shared theme, existing names; a single `.dark` override block. Default dark; stored appearance choice remains authoritative.
- Performance: no added runtime dependency, WebGL, video backdrop or remote design asset.
- Compatibility: do not change wallet keys, salts, origins, permission rules, transaction preparation or signing as part of branding.
- Validation: focused typecheck/lint, contrast calculation, browser inspection of desktop/mobile and both themes; verify deposit/withdraw and wallet dialog inherit the palette.

## Open questions
- [x] Product name — **eziee**. GGEZ is inspiration, not the product name.
- [ ] Preferred GGEZ scene — owner; current direction uses the overall storyboard palette and graphic attitude.
- [ ] Jev integration contract and DeFi evaluation — product/engineering; determine schemas, thresholds, timeout/fallback behavior and measured performance before shipping model claims.
