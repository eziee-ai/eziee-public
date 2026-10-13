# Plan 8 — MCP Protocol Adapter and Conformance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A protocol other than Iter can join: its reviewed manifest is compiled in, its MCP server builds transactions and answers reads, and nothing its server says can reach a wallet unless the manifest decodes it as the action that was asked for.

**Architecture:** One class serves every Verified protocol. `createMcpAdapter(manifest, caller)` turns `tools/list` into reads and into builds for the actions the MANIFEST declares, and no others. `acceptBuild` is the single acceptance rule for a server's transactions; it runs on our server, again in the browser against the bundled manifest, and the wallet frame decodes independently after that. The browser never holds a protocol's API key: it asks `POST /api/protocols/<id>/build`, which builds for the session's address. Which protocols are trusted is a compiled-in list; configuration only says where a trusted protocol's server is.

**Spec:** D11, §15; guideline §5–§7.

## Global Constraints
- Branch `feat/plan-8-mcp-adapter` from `feat/plan-7-iter-liquidity`.
- A server's text is data: cleaned, capped, labelled. An action is described from the manifest, never from the server.
- Never follow a redirect with a key. Cap a response at 64 KB while it streams. Reads time out at 2 s, builds at 3 s.
- A check that could not be made is reported as "not run", never as a pass.

---
- [x] **Task 1: shared pieces.** `src/text.ts` (`clean`) and `src/simulate.ts` moved out of the Iter adapter; `AdapterAction.intentJsonSchema` and `AdapterRead.inputJsonSchema`; the agent shows them to the model through `jsonSchema`.
- [x] **Task 2: `createHttpMcpCaller`.** Stateless Streamable HTTP: JSON or event-stream replies, HTTPS only, `redirect: "error"`, byte cap while streaming, timeout, failures that never repeat what the server or the network said.
- [x] **Task 3: `createMcpAdapter` and `acceptBuild`.** Tool names `<id>.(read|build).<name>`, reserved JavaScript names refused, builds only for manifest actions, the acceptance rule, error codes mapped with unknown ones distrusted, read results sanitized (strings, keys, depth, size).
- [x] **Task 4: conformance.** `src/conform/checks.ts` (`checkChain`, `checkServer`, `summarize`), `src/conform/proxy.ts` (shared with the vendoring script), `scripts/conform.ts`, `pnpm protocols:conform`. Run against the live Iter manifest on both testnets: 47 passed, 3 not run.
- [x] **Task 5: a reference server and a test over real HTTP.** `src/testing/referenceServer.ts`; honest and dishonest servers through the caller, the adapter and the conformance checks.
- [x] **Task 6: the app.** `VERIFIED_MANIFESTS` (empty until a protocol is reviewed), `createProxiedMcpAdapter` for the browser, `lib/server/protocols.ts` (`createProtocolSource`, `handleBuild`, `mcpEndpoint`), `POST /api/protocols/[id]/build`, the chat handler, the models route, the wallet's registry and the chat view all read the same list.
- [ ] **Not in this plan:** the Custom tier (a person adds their own MCP server, read-only). No Verified protocol exists yet, so the path from the picker to a third-party build has unit and integration tests but no end-to-end test in the app. Verified-source matching and forked-chain asset-movement simulation in the conformance command.

## Closed on review
- `acceptBuild` pins an approval to the contract the action calls, and refuses a trade that accepts nothing in return.
- The slippage rule is mechanical where it can be: a swap-like action is offered only if its intent requires `maxSlippageBps`. That the server honours it is review's job and the person's, on the wallet card.
- A protocol's quote expiry was validated and then thrown away. It now travels with the transactions and is checked again right before each one is sent.
- A server's JSON Schema was an unlabelled text channel to the model, and cleaning it as text mangled it. It is rebuilt from an allowlist of keywords, with prose cleaned and marked.
- An address inside an array of tuples was invisible to the "every address accounted for" rule.
- The guideline's example manifest did not parse. It is now real JSON and a test parses it. Checks that do not exist are no longer described as existing.
- Conformance: strict flags, JSON output on every path, `--strict`, proxy admin compared with the chain, and a failure for anything the app will refuse to offer.
