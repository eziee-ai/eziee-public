# eziee

An AI desk for using DeFi protocols. A person connects a passkey wallet and asks an agent to look things up, swap, or place an order. The agent prepares the transaction. The wallet, which runs in its own isolated frame, decodes what the transaction really does, shows it, and asks before anything is signed.

Brand direction and component guidance live in [DESIGN.md](DESIGN.md). Open [the brand board](docs/brand/index.html) to compare the palette in dark and light modes. Rate is one integration; Jev is the intended structured-decision layer, with runtime integration still to be implemented.

## Run it

```bash
pnpm install
cp apps/web/.env.example apps/web/.env.local   # then set AI_GATEWAY_API_KEY
pnpm dev                                       # http://localhost:3000
```

No database account is needed locally: without `DATABASE_URL` the app uses an embedded Postgres (PGlite) under `apps/web/.data/`. A new account has no credit, so add some before chatting:

```bash
pnpm --filter @repo/db credit:adjust 0xYourWalletAddress 5 "local testing"
```

`TYPESAFE_API_KEY` is optional and server only: with it set, the text of the person's latest message (nothing else) is sent to TypeSafe's Jev model to read what they asked for. The reading runs beside the chat model rather than in front of it, and a market ranking is shown first only when the reading is confident and the model has not yet said anything. Setting the key also changes what such a turn costs: a turn the reading acts on starts two model calls and is billed for the one it gives up on as well as the one it keeps, about one and a half times an ordinary turn, while every other turn costs what it does today. Any failure, or leaving the key unset, changes nothing about how the chat answers.

Every variable is documented in `apps/web/.env.example`.

Under each reply the chat shows the model, the tokens in and out, and the cost. A chip beside the prompt sums the chat and shows how much of the model's window the last reply used. Another shows the credit left and roughly how many replies it buys, counting from the credit a send must hold. A chat that outgrows the model's window keeps its whole history but sends the model only the newest messages that fit, and says so above the first one it sends.

The Tokens page lists what the wallet holds on each network, lets you pin and hide tokens, and adds one by address after an onchain check of its code, symbol, name, decimals and balance. An added token is shown and can be withdrawn. The assistant never trades it, and it never reaches the model or the reviewed registry.


## Layout

| Path | What it is |
|------|------------|
| `apps/web` | The Next.js app: the landing page, chat, tokens, deposit, withdraw, permissions, credit, and the wallet frame under `/wallet-frame`. |
| `packages/wallet` | The passkey wallet, its frame protocol, and the rule engine that decides what may be signed without asking. |
| `packages/protocols` | The `ProtocolAdapter` seam, the manifest schema and decoder, the registry, and Rate, the first-party adapter. |
| `packages/agent` | The protocol registry turned into model tools, the prompt, the model list, and the metering math. |
| `packages/db` | Sign-in, chat history and the credit ledger, over Postgres or PGlite. |
| `packages/ui` | Brand and shared styling helpers. |
| `DESIGN.md` | Current brand and product design direction. |
| `docs/superpowers/specs` | Technical product and wallet design. |
| `docs/superpowers/plans` | What was built, slice by slice. |
| `docs/protocol-integration/mcp-guideline.md` | How another protocol joins. |

A protocol other than Rate joins by publishing an MCP server and a reviewed manifest. Its manifest is added to `VERIFIED_MANIFESTS` (`packages/protocols/src/registry/verified.ts`), which is compiled into the app and the wallet; its server's address is deployment configuration. Check a submission with:

```bash
pnpm protocols:conform packages/protocols/registry/<id>/manifest.json --mcp <url> --mcp-key-env <NAME> --samples <file>
```

## Checks

```bash
pnpm typecheck && pnpm lint && pnpm test
pnpm --filter @repo/web build
pnpm e2e        # Playwright, with a scripted model and a mocked chain; E2E_PORT=3300 moves its ports
```

`pnpm test` in `packages/protocols` also checks every vendored contract address for code on its testnet, so it needs network access.

## Rules that do not bend

- The wallet's key never leaves the wallet frame. In production the frame is a separate origin; set both `NEXT_PUBLIC_WALLET_*` variables together.
- The model is untrusted. It proposes typed intents and never supplies calldata, an address or base units. Only the wallet's own card leads to a signature.
- No contract address is typed by hand. Rate's are vendored by `pnpm --filter @repo/protocols vendor:rate` and verified onchain.
- Protocol manifests are reviewed and bundled at build time. Nothing is fetched and trusted at runtime.
- Money is integer micro-USD. A model call is held for before it runs and settled after.
