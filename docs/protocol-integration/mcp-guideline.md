# Protocol Integration Guideline (MCP)

Status: Draft v0.1, 2026-09-20. Audience: teams who want their protocol to be usable from the chat.
Companion to `docs/superpowers/specs/2026-09-18-agentic-trading-chat-design.md` (§6, §15).

## 1. What "joining" means

A user types "swap 50 USDC to ETH". The agent picks one of your protocol's actions, your
server builds the transaction, and the user's passkey wallet decides whether to sign it.

You ship two things:

| Piece | What it is | Who hosts it | Trust level |
|---|---|---|---|
| **MCP server** | Tools that read your protocol and build transactions | You | Untrusted. Everything it returns is checked. |
| **Protocol manifest** | A static JSON file: contracts, tokens, actions, and how to decode each action's calldata | Merged into this repo by review | Trusted. It is the only thing the wallet believes. |

You never receive a key, a signature request, a user's permission rules, or chat content.
The model never writes calldata and never chooses a contract address; it only fills in a
typed intent that your `build` tool turns into transactions.

Rate, the first protocol, is an in-repo TypeScript adapter. It publishes the same manifest
format, so the wallet has one decoding path for every protocol.

## 2. Rules that cannot be waived

These come from the wallet's invariants (spec §5.3). A submission that breaks one is rejected.

1. Every transaction's `to` is a contract listed in your manifest for that chain.
2. Every transaction decodes, using only your manifest, to the same action and spend that the
   intent asked for. The wallet frame does this decode itself; it never reads your server's
   description of the transaction.
3. Approvals are exact. `approve(spender, amount)` where `spender` is a manifest contract with
   role `router` and `amount` equals the action's spend. Never `type(uint256).max`.
4. Output tokens go to the signer. If an action has a recipient argument, the manifest names
   it and the frame requires it to equal the user's address.
5. An action that spends one token to receive another carries the PERSON's slippage limit.
   Mechanically: its intent must REQUIRE an integer `maxSlippageBps`, or the app does not offer
   it, and a transaction whose minimum received is zero is refused. By review: that `build`
   honours the limit, re-quotes, and answers `QUOTE_MOVED` rather than building a worse trade.
   The wallet card shows the minimum received from the calldata itself, so the person sees it.
6. No proxies you can repoint without review. An upgradeable contract must declare its proxy
   type and admin in the manifest; an implementation change requires a manifest re-review
   before "Always allow" rules keep applying.
7. Tool output is data. Text your server returns is never treated as an instruction to the
   model, is length-capped, and is rendered as plain text.

## 3. Trust tiers

| Tier | How it gets there | What users can do |
|---|---|---|
| **First-party** | In-repo adapter (Rate) | Everything, including "Always allow" rules |
| **Verified** | Manifest merged after review, conformance suite green | Everything, including "Always allow" rules |
| **Custom** | A user pastes an MCP URL in Settings | Reads only. No transactions are built from it. |

Custom servers cannot produce transactions because there is no reviewed manifest for the
wallet to decode against, and an undecodable confirm card is an invitation to sign blind.

## 4. The manifest

Path in this repo: `packages/protocols/registry/<id>/manifest.json`. The schema is code:
`packages/protocols/src/manifest/schema.ts` (`parseManifest`), and it is strict: an unknown key
anywhere is an error, not something ignored.

This example parses. A test (`guidelineExample.test.ts`) feeds it to `parseManifest`, so it
cannot drift from the schema. Its addresses are obviously fake; yours are never typed by hand (§7).

<!-- manifest-example:start -->
```json
{
  "manifestVersion": 1,
  "id": "yourprotocol",
  "name": "Your Protocol",
  "version": "1.0.0",
  "homepage": "https://yourprotocol.example",
  "icon": "icon.svg",
  "mcp": { "url": "https://mcp.yourprotocol.example/mcp", "transport": "streamable-http" },
  "chains": [900001],
  "contracts": {
    "900001": {
      "router": {
        "address": "0x0000000000000000000000000000000000000101",
        "role": "router",
        "source": "https://yourprotocol.example/deployments.json",
        "proxy": { "type": "none" }
      }
    }
  },
  "tokens": {
    "900001": [
      { "address": "0x0000000000000000000000000000000000000201", "symbol": "USDC", "name": "USD Coin", "decimals": 6, "trust": "canonical" },
      { "address": "0x0000000000000000000000000000000000000202", "symbol": "WETH", "name": "Wrapped Ether", "decimals": 18, "trust": "listed" }
    ]
  },
  "actions": {
    "swap": {
      "title": "Swap",
      "spends": true,
      "calls": [
        {
          "contract": "router",
          "abi": "function swapExactIn(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address to, uint256 deadline)",
          "spend": [{ "token": { "arg": "tokenIn" }, "amount": { "arg": "amountIn" } }],
          "receive": { "token": { "arg": "tokenOut" }, "minAmount": { "arg": "minOut" } },
          "recipient": { "arg": "to" },
          "deadline": { "arg": "deadline" }
        }
      ]
    },
    "closePosition": {
      "title": "Close position",
      "spends": false,
      "alwaysAsk": true,
      "calls": [{ "contract": "router", "abi": "function close(uint256 positionId, address to)", "recipient": { "arg": "to" } }]
    }
  }
}
```
<!-- manifest-example:end -->

Field notes:

- `id` is lowercase `[a-z0-9-]`, unique and permanent. `version` is the semver of THIS file.
- `role` is `router`, `pool-manager`, `factory` or `other`. Only a `router` may ever be approved
  as a token spender, and an approval must be to the router the action itself calls.
- `proxy` is `{ "type": "none" }`, or `uups`, `transparent`, `beacon` or `clone`. A `transparent`
  proxy declares its `admin`, and conformance compares it with the chain.
- `icon` sits in the same folder, monochrome-safe, at most 8 KB. `mcp.url` is for reviewers;
  the address our deployment calls is its own configuration (`MCP_<ID>_URL`).
- `calls` are ALTERNATIVES, not a sequence. An action is one transaction, which must match
  exactly one of them (a limit order is `limitBuy` or `limitSell`). A flow that needs several
  protocol calls in a row is several actions.
- `alwaysAsk` marks an action no rule may ever cover, because it can give something up that no
  spend amount describes (closing a position early and forfeiting what had not vested).
- There is no intent schema in the manifest. The shape of an intent comes from your server's
  `inputSchema` (§5). It tells the model what to send; it is never what makes a transaction
  acceptable. The manifest's decode of what `build` returns is.

Decoder vocabulary, deliberately small: `{ "arg": "<name>" }`, `{ "const": "<value>" }`,
`"native"` for the chain's native asset, and `"msg.value"`. Token decimals are read onchain
by the frame and compared with the manifest; a mismatch disables the token. If an action
cannot be expressed with this vocabulary (packed paths, multicall bytes), propose an
extension in your PR. Custom decoder code is accepted only for first-party adapters.

Rules the schema and decoder enforce mechanically, so review does not have to catch them:

- **Every address a call takes is accounted for, whether or not the call spends.** Each `address` input (tuple members included) must be the `recipient`, a `spend` or `receive` token, or appear under `"ignore": [{ "arg": "referrer", "reason": "…" }]` with a reason a reviewer can weigh. An unexplained address (a `refundTo`, a `feeRecipient`) is where funds get redirected, so the manifest does not parse. A call that spends nothing is no exception: withdrawing a position or claiming fees spends nothing and still pays out to an address in its arguments, and an action that spends nothing is exactly the kind a person will allow without asking.
- **Inputs are named and unique.** An unnamed or repeated input name makes an argument reference ambiguous; the manifest does not parse.
- **Native value is reconciled exactly.** The native spend a call declares must equal `tx.value`, and a call that declares none must carry none. Anything else decodes as unknown.
- **One meaning per calldata.** The calldata must be the canonical ABI encoding of its arguments: no bytes appended, no dirty upper bits in an address word.
- **Receive tokens are held to the spend standard.** An unlisted token on either side decodes as unknown.

An action with `"spends": false` is the only kind a user may allow for "any" token (spec §5.3).

## 4a. Where ABIs come from

MCP has no notion of an ABI, and a new project's server will not ship one. It does not need to:

| Need | Who supplies it | How |
|---|---|---|
| **Encoding** a transaction | Your server | `build` returns finished calldata. We never encode your calls, so we need no ABI for it. |
| **Reading** your protocol | Your server | `read` tools return data. We never call your view functions. |
| **Decoding** a transaction, which is the part that protects the user | The manifest | Each action call carries the one human-readable function signature it uses (`"abi": "function swapExactIn(...)"`). That fragment is the entire ABI surface the wallet needs. A full ABI file is never downloaded. |

So a protocol's ABI footprint in this repo is a handful of signatures, reviewed once, not an artifact fetched at runtime.

A signature in a manifest is a CLAIM. Three checks make it a verified one. The second is
mechanical today; the first and third are done by hand in review, and the conformance command
says so on every run rather than letting a green result imply them.

1. **Verified-source match (by hand).** The reviewer compares every manifest signature with the
   contract's verified source on its explorer: same function, same parameter names and types. A
   contract with no verified source cannot reach the Verified tier.
2. **Round trip (mechanical).** For each action, `build` output must decode through the manifest
   back to the action that was asked for: selector, spend token, amount, recipient. It runs in
   conformance for every sample intent, and again in the app on every build. A signature that does
   not match the deployed function fails here even if a verifier is wrong or stale.
3. **Asset-movement check (by hand).** The reviewer simulates each built transaction on a forked
   chain and compares the ERC-20 `Transfer` logs and native value leaving the signer with the
   decoded `spend`. Anything leaving the signer that the manifest did not declare fails the
   action. This is what catches a manifest whose argument NAMES are truthful but whose contract
   moves something else. Doing this in conformance, and in the browser before a confirm card on
   chains that can simulate with logs, is an open point (§8), not something that exists.

A project with no manifest at all stays in the Custom tier (§3): read-only. If its contracts are verified, the app may fetch that ABI to LABEL an unknown transaction on the confirm card ("calls `stake(uint256)` on an unregistered contract"), but a fetched ABI never makes a transaction eligible for a rule, and the card still says the contract is unknown.

## 5. The MCP server

Target: MCP specification 2025-06-18 or later, Streamable HTTP transport over HTTPS, stateless.
No user authentication: calls come from our backend, identified by an API key you issue us,
sent as `Authorization: Bearer <key>`.

"Stateless" is meant literally. Our client sends one JSON-RPC request per POST, with no
`initialize` handshake and no session id, and expects `tools/list` and `tools/call` to answer
on their own. It accepts a JSON body or an event stream (`text/event-stream`) carrying the
reply. It never follows a redirect, because a redirect would carry your key to wherever it
points. A worked example of a conforming server is `packages/protocols/src/testing/referenceServer.ts`.

### 5.1 Tools

Names are fixed so the agent layer can generate its tool list from `tools/list`:

| Tool | Called by | Purpose |
|---|---|---|
| `<id>.read.<name>` | Our server, when the model asks | Quotes, pools, order books, positions. `annotations.readOnlyHint: true`. |
| `<id>.build.<action>` | Our server, on behalf of the signed-in user's browser | Returns the transactions for one manifest action. |

There is no `simulate` tool. We simulate every returned transaction ourselves with `eth_call`
and `estimateGas` from the user's address, and we do not trust a server's claim that it succeeds.

Every tool declares `inputSchema` and `outputSchema`, and answers in `structuredContent`.

### 5.2 `build` contract

```jsonc
// input
{ "chainId": 11155931, "account": "<USER ADDRESS>", "intent": { /* validates against the manifest intent */ } }

// output
{
  "txs": [ { "chainId": 11155931, "to": "<ADDRESS>", "data": "0x…", "value": "0" } ],   // ≤ 4, in order
  "quote": { "spend": [{ "token": "<ADDRESS>", "amount": "50000000" }],
             "receive": { "token": "<ADDRESS>", "estimated": "24900000000000000", "minimum": "24780000000000000" } },
  "expiresAt": 1789925000                                                                  // unix seconds
}
```

- Amounts are decimal strings in base units, in `build` AND in read results: a JSON number past
  2^53 has already lost digits by the time anyone parses it, so we pass such a number to the
  model as unknown. Addresses are EIP-55. Hex is `0x`-prefixed.
- A transaction is exactly `chainId`, `to`, `data`, `value`. Any other field is a refusal.
- `expiresAt` is honoured: the app will not hand the wallet a transaction after it, however
  long the person took over the step before. Ours is at most 60 seconds; yours wins if sooner.
- A result with no `structuredContent` is an error to us, not an empty answer. A list longer
  than 500 entries is an error too: page it.
- `quote` is for display in the chat's quote card only. The confirm card is drawn from the
  frame's own decode of `txs`, never from `quote`.
- `build` must be deterministic for the same input and block, and must not depend on any
  state your server keeps about the user.

### 5.3 Errors

Return `isError: true` with `structuredContent: { "code": "...", "message": "..." }`.
Codes: `INVALID_INTENT`, `UNKNOWN_TOKEN`, `UNSUPPORTED_CHAIN`, `QUOTE_MOVED`,
`INSUFFICIENT_LIQUIDITY`, `AMOUNT_TOO_SMALL`, `TEMPORARILY_UNAVAILABLE`. The model sees the
code and explains or adjusts; it is forbidden from retrying a user-denied action.

### 5.4 Budgets

Reads answer in under 2 s at p95, `build` in under 3 s. Responses are capped at 64 KB.
A server that misses budgets for a sustained period is hidden from the protocol picker until it recovers.

## 6. How it plugs in on our side

Nothing in the chat, agent or wallet layers is protocol-specific. One interface is the seam:

```
ProtocolAdapter (spec §6)
├── RateAdapter            in-repo TypeScript, first-party
└── McpProtocolAdapter     built from (manifest, MCP client); one class serves every Verified protocol
```

`McpProtocolAdapter` (`createMcpAdapter`) maps `reads.*` to `<id>.read.*`, `actions.*.build` to
`<id>.build.*`, implements `simulate` locally, and implements `decode` from the manifest alone.

What your server returns from `build` is accepted or refused as a whole, by one rule
(`acceptBuild`), before anything reaches a wallet: at most four transactions, all on the chain
asked for, unexpired; the LAST one must decode, from the manifest alone, as the very action that
was asked for, with the user as recipient; every one before it must be an approval the manifest
allows, to a `router` contract, for exactly the amount of one token that action spends, once.
An unknown field on a transaction is a refusal, not something we ignore. The same rule runs
three times: on our server, again in the user's browser against its own bundled manifest, and
the wallet frame then decodes the transaction on its own before it signs.

The browser never talks to your server, because your key must not reach a browser. It asks our
server (`POST /api/protocols/<id>/build`), which builds for the signed-in session's address and
ignores any account in the request.

Text from your server is data for a language model. Read results and error messages are stripped
of invisible, direction-changing and markup characters and capped in size and depth. A read's
description is passed on marked as your server's text. An ACTION is never described by your
server: the model sees the title from the reviewed manifest, and your `inputSchema` for the
intent's shape. Manifests are
bundled into the wallet frame at build time. The frame never fetches one at runtime, so a
compromised server or CDN cannot widen what the wallet will sign.

The protocol picker in the prompt input (spec §7.4) scopes which adapters' tools the model
is given for a message. "Auto" offers every enabled protocol on the active network.

## 7. Conformance and submission

Run before opening a PR:

```bash
pnpm protocols:conform packages/protocols/registry/<id>/manifest.json \
  --rpc <chainId>=<url> \
  --mcp https://mcp.your-protocol.example/mcp --mcp-key-env YOUR_KEY_VARIABLE \
  --samples packages/protocols/registry/<id>/samples.json
```

`samples.json` gives one intent per action, so every `build` is exercised:
`{ "swap": { "chainId": 11155931, "intent": { "tokenIn": "0x…", "amountIn": "5" } } }`.
The key is read from the environment variable you name, so it never appears on a command line.
The command exits non-zero if any check failed, and lists what it did NOT check as "not run".
Read that list: a green run with actions not exercised proves nothing about them.

It checks: the manifest schema; that every address has code on its chain and tokens answer
`symbol()` and `decimals()` as declared; that proxy slots match the declared proxy type; that
`tools/list` offers a `build` for every manifest action; and, for each action with a sample,
that `build` passes `acceptBuild` (above): it decodes as that action, approvals are exact and to
a `router`, and the recipient is the account.

It does not check two things §4a requires, and says so on every run: that each manifest
signature matches the contract's verified source, and that simulated asset movements equal the
decoded spend on a forked chain. Both are done by hand in review. How oversize, slow and
instruction-bearing responses are handled is our adapter's job, and is covered by its tests.

Submission: one PR adding `registry/<id>/` with the manifest, `samples.json`, icon, and the
conformance report (`--json`), and adding the manifest to `VERIFIED_MANIFESTS`
(`packages/protocols/src/registry/verified.ts`). That list is compiled into the app and the
wallet frame; being on it is what "Verified" means. The server's address and key are our
deployment's configuration (`MCP_<ID>_URL`, `MCP_<ID>_KEY`) and are not part of the PR. Review covers the address sources, the decoders, and proxy admin risk. Later changes:

| Change | Needs |
|---|---|
| MCP server behaviour, new `read` tools | Nothing, as long as conformance stays green |
| New action, new contract, new chain, changed address | Manifest PR and review |
| Proxy implementation change | Manifest re-review; "Always allow" rules for the protocol pause until it lands |

We can disable a protocol at any time. Disabling hides it from the picker and makes the
frame refuse its rules; it never affects a user's ability to withdraw.

## 8. Open points

- Signed manifests (so a fork of this app can verify provenance) are not in v0.1.
- One `build` returns at most 4 ordered transactions, of which only the last is the action; the
  ones before it are approvals. An action made of several protocol calls is not expressible yet.
- Conformance does not yet compare signatures with verified source, nor simulate asset movements
  on a fork; both are done by hand (§4a). The browser does not simulate with logs before a
  confirm card either.
- A `bytes` argument can carry an encoded address that no schema rule can see. A call that takes
  opaque `bytes` needs a reviewer's explicit justification.
- Listing criteria beyond technical conformance (audits, TVL, jurisdiction) are the owner's call.
