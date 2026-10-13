# Where the implementation stands (2026-09-26)

This is the handoff from the autonomous implementation run. It says what exists, on which branch, what was checked and how, and what is deliberately not built. Each plan's own record is in `docs/superpowers/plans/`.

## Branches

Plans 1 to 11 were merged into `main` on 2026-09-20 (`7631bcf`). The branches below are that history. The current tip is `feat/plan-12-tokens-motion`, which sits on `main` and adds the brand pass and Plan 12; see the Plan 12 section at the end. Nothing from Plan 12 was pushed.

| Branch | What it adds |
|---|---|
| `feat/plan-1-scaffold-and-wallet` … `feat/plan-5-iter-actions` | Monorepo, passkey wallet and frame, protocol seam, transfers, rule engine, Iter swap and orders. |
| `feat/plan-6-agent-chat` | Database, agent package, sign-in, metered chat route, chat UI, end-to-end tests. |
| `fix/plan-6-review` | Every finding of the Plan 6 security review and code review, and the one gap an independent verifier found afterwards. |
| `feat/plan-7-iter-liquidity` | Iter add and remove liquidity and collect fees. |
| `feat/plan-8-mcp-adapter` | The MCP protocol adapter, `pnpm protocols:conform`, the app wiring for Verified protocols. |
| `feat/plan-9-credit-topup` | Adding credit with USDC, `/settings/credit`, a hermetic server-side chain for end-to-end tests. |
| `feat/plan-10-funding-route` | Aurora Intents funding route, server side, gated off for the testnets. |
| `fix/plans-7-9-review` | Every finding of the security review and code review of Plans 7 to 9. |
| `feat/plan-11-jev-router` | A `rank` read that orders Iter's markets by a named measure; a router that asks TypeSafe's Jev what a message wants; the chat turn runs that read beside the model and shows the table first. Off without `TYPESAFE_API_KEY`. Merged into `main`. Record: `plans/2026-09-20-plan-11-jev-router.md`; evidence: `docs/research/2026-09-20-jev-spike/`. |

## The brand pass

A brand and design pass (`DESIGN.md`, `docs/brand/`, the landing page, an onboarding dialog, restyled chat and transfer components, an email waitlist) was made in the main checkout on `feat/plan-6-agent-chat`, branched before the reviewed stack. Plan 12 merged it into `main`'s history: the stack's behaviour was kept and the brand's presentation layered on, the waitlist migration was renumbered to `0002`, and the end-to-end suite learned to dismiss the first-run dialog as a person does.

## Not built, on purpose

- **Card and utility-token top-up rails.** The card rail needs a Stripe account to be tested against anything real. The token rail prices a token on a market that does not exist yet. Neither is listed as available, whatever is configured.
- **Rate `launchCoin`, `addLiquidityAcross`, `addLiquiditySingleSided`, native-in swaps on RISE.**
- **The Custom tier** (a person's own read-only MCP server).
- **The two funding sections in the interface.** No network this app serves is one Aurora Intents delivers to, so they could not be seen or tested. The server side is there. Its client was written against the published API reference and has not been run against the live service, which needs a key.
- **A reorg sweep for credited deposits.** A deposit is credited after 12 blocks while its block is still canonical. A deeper reorg is not reversed.

## Decisions that need the owner

1. **Who holds the treasury key**, before `BILLING_TREASURY_ADDRESS` is set on a mainnet.
2. **Testnet credit.** It is off unless `BILLING_ALLOW_TESTNET_CREDIT=1`, because testnet USDC is free and the credit spends real model money. Both networks this build serves are testnets, so today the USDC rail is off everywhere until you decide.
3. **A rule caps what goes out, not what comes back.** Accepted in the rule engine review and disclosed in the rule editor. It still wants your sign-off.
4. **Licences.** The Rate (formerly Iter) token list is GPL-3.0 and the vendored ABIs derive from BUSL-1.1 contracts.
5. **`pnpm test` in `packages/protocols` checks vendored addresses against the live testnets**, so that one package's tests need the network.

6. **Plan 11's open points**, listed under "Left for the owner" in its plan: whether the abandoned speculative model call is charged or absorbed, the router's confidence gate, Jev's own cost, and that the agent's loop-stop does not see the abandoned call's charge.

## How it was checked

At the tip (`feat/plan-12-tokens-motion`, 2026-09-26): typecheck and lint clean across six packages, the production build passes, **1,067 unit tests pass** (464 in the web app, 65 in the agent package, 257 protocols, 248 wallet, 31 db, 2 ui), and the **44 end-to-end tests pass with no retries** on a worktree of their own (`E2E_PORT=3300`). The end-to-end suite runs the real app against a scripted model, a mocked chain in the browser and a second mock chain for the server, so it needs no live network. At Plan 11's tip the numbers were 936 unit tests and 35 end-to-end tests; CI (`.github/workflows/ci.yml`) is green there.

Every plan was built test-first and then reviewed by an independent security reviewer and an independent code reviewer, neither of which could edit. Their findings were fixed, and the fixes were then checked by an independent verifier, whose own findings were fixed too. What the last verifier pass found was small and is closed in the final commit; that final commit has not itself been through another independent pass. The reviews found real problems each time, including two in billing that would have cost money. The plan records list them.

## Plan 12: token management and chat motion (2026-09-26)

Branch `feat/plan-12-tokens-motion`, on `main` plus the brand pass. Record: `plans/2026-09-23-plan-12-tokens-and-motion.md`.

- **The brand pass is merged.** `feat/plan-6-agent-chat` (landing page, Vercel workflow, email waitlist, first-run dialog) was merged into the reviewed stack. The waitlist migration became `0002`. Conflicts in ChatView, AppShell, Sidebar and the credit page were resolved by keeping the stack's behaviour and the brand's presentation.
- **Usage.** Each reply carries its tokens, its context size and the model's window. The chat sends the model only the newest history that fits the window and tells the browser how many messages it left out. The UI shows a usage chip, a per-reply line and a divider at the trim point.
- **Credit at the prompt.** A chip shows spendable credit and roughly how many replies it buys, counted from the per-send floor the server reports. The session response now carries the held amount and the minimum hold, read lazily so a bad billing variable cannot break sign-in.
- **Tokens page.** `/tokens` lists balances, pins and hides tokens, and adds a token by address after an onchain check. Added tokens are display-and-withdraw only; the withdraw confirm card labels them and shows the contract address, and warns when one borrows a reviewed symbol.
- **Motion.** A streaming cursor, pending dots, a four-step progress bar on action cards, a drawn check on confirmation, and a rise-in on new replies and cards. Everything is off under reduced motion.
- **Test ports.** `E2E_PORT` moves the whole Playwright suite, so two checkouts can run it at once.

### Decisions that need the owner, added by Plan 12

7. **The first-run dialog has no route check.** It opens on whatever screen a person signs in on, including Deposit and Withdraw. The end-to-end suite dismisses it; a person has to as well.
8. **The pitch videos carry a developer badge.** Both files in `apps/web/public/pitch/` have the Next.js "1 Issue" badge recorded in the corner. Re-record from a production build before publishing.
9. **A given-up speculative call can be charged twice** in a rare ordering (`apps/web/lib/server/speculation.ts:86`). Found by the Plan 12 usage review, outside its diff, not fixed.
