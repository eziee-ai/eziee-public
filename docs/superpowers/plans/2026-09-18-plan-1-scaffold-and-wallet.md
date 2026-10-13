# Plan 1 — Monorepo Scaffold and Passkey Wallet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Turborepo monorepo whose Next.js web app lets a user create or unlock a passkey (mera) wallet, see their address and session expiry, and resume the session on reload without a prompt.

**Architecture:** The wallet is ported by *copying* Iter's audited files into `packages/wallet` and changing only named constants and imports; key-handling logic is never rewritten. App-specific facts (chains, brand, known contracts) are injected through one `configureWallet()` call so the package depends on nothing else in the repo. The key lives in `/wallet-frame` routes served with a strict nonce CSP; on localhost the frame is same-origin, in production it sits on a separate wallet origin.

**Tech Stack:** pnpm 10.33.0, Node 22, Turborepo ^2.5, TypeScript ^5.8 (strict), Next.js ^16.3.4 (App Router), React ^19, Tailwind CSS ^4.0.9, viem ^2.23.5, wagmi ^2.14.12, @tanstack/react-query ^5.76.1, `@category-labs/mera` **0.2.0 exact**, Vitest ^2.1.9, jsdom ^30, fake-indexeddb ^6, Playwright ^1.50.

**Spec:** `docs/superpowers/specs/2026-09-18-agentic-trading-chat-design.md` (this plan implements §4, §5.1, §5.2, §5.4 routes `/wallet-frame`, `/wallet-frame/confirm`, `/wallet-frame/blocked`, §5.5, and build-order milestones 1–2).

**This is Plan 1 of a sequence.** Later plans (each written when its inputs exist): 2 — protocols + Iter reads + deposit/withdraw; 3 — rule engine + confirm/rules pages + Iter actions; 4 — db + sign-in + credit ledger + metering + agent + chat UI; 5 — Aurora Intents + E2E + a11y; 6 — billing top-up rails (USDC, card, utility token; spec §14).

## Global Constraints

- Source of ported code: `SRC=/Users/hyungsukkang/iter-cx/iter-monorepo/apps/web`. **Copy with `cp`, then apply only the edits listed.** Do not retype, reformat, or "improve" ported files. Keep their comments.
- `@category-labs/mera` is pinned to exactly `0.2.0` (no caret).
- PRF salt is exactly `"wlt1.mera.v1.secp256k1.account\0\0"` (32 bytes). Fixed forever once shipped.
- Storage keys: `wlt.mera-credential`, `wlt.mera-session`; IndexedDB name `wlt.mera`; postMessage channel `wlt.wallet-frame`.
- `mera_sendBatch` is not supported anywhere (no EIP-7702 batching in v1).
- Workspace scope is `@repo/*`. Product name comes only from `BRAND` in `packages/ui/src/brand.ts` (value `"AI Finance"`).
- `packages/wallet` must not import from `@repo/protocols`, `@repo/agent`, or `@repo/db`.
- Internal packages export TypeScript source (`"exports"` → `./src/*.ts`); the app lists them in `transpilePackages`.
- No `test.skip`, `test.only`, TODO placeholders, floating `any` casts added to ported code.
- Terminology: onchain, offchain (one word). Addresses are never truncated in code; only UI may shorten them.
- Every commit message ends with: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`
- Work on branch `design/agentic-trading-chat` is finished; create and use branch `feat/plan-1-scaffold-wallet` from it.

---

### Task 1: Monorepo scaffold

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `.nvmrc`, `.gitignore`, `.npmrc`
- Create: `packages/typescript-config/{package.json,base.json,next.json}`
- Create: `packages/eslint-config/{package.json,base.mjs,next.mjs}`

**Interfaces:**
- Produces: workspace scripts `pnpm typecheck | lint | test | build | dev` (all via turbo); tsconfig presets `@repo/typescript-config/base.json` and `/next.json`; ESLint flat configs `@repo/eslint-config/base` and `/next`.

- [ ] **Step 1: Branch**

```bash
git switch design/agentic-trading-chat && git switch -c feat/plan-1-scaffold-wallet
```

- [ ] **Step 2: Root files**

`package.json`:
```json
{
  "name": "ai-finance",
  "private": true,
  "packageManager": "pnpm@10.33.0",
  "engines": { "node": "22.x" },
  "scripts": {
    "build": "turbo run build",
    "dev": "turbo run dev",
    "lint": "turbo run lint",
    "typecheck": "turbo run typecheck",
    "test": "turbo run test",
    "e2e": "pnpm --filter @repo/web e2e"
  },
  "devDependencies": {
    "turbo": "^2.5.0",
    "typescript": "^5.8.0",
    "prettier": "^3.5.0"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - "apps/*"
  - "packages/*"
```

`turbo.json`:
```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": [".next/**", "!.next/cache/**", "dist/**"],
      "env": ["NEXT_PUBLIC_WALLET_ORIGIN", "NEXT_PUBLIC_WALLET_APP_ORIGIN"]
    },
    "dev": { "cache": false, "persistent": true },
    "lint": {},
    "typecheck": { "dependsOn": ["^typecheck"] },
    "test": {}
  }
}
```

`.nvmrc`: `22`

`.npmrc`:
```
auto-install-peers=true
```

`.gitignore`:
```
node_modules
.next
dist
.turbo
.env
.env.local
.env*.local
.omc/
!.omc/skills/
test-results
playwright-report
*.tsbuildinfo
```

- [ ] **Step 3: `packages/typescript-config`**

`package.json`:
```json
{ "name": "@repo/typescript-config", "version": "0.0.0", "private": true, "files": ["base.json", "next.json"] }
```

`base.json`:
```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": false,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "react-jsx",
    "noEmit": true
  }
}
```

`next.json`:
```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "./base.json",
  "compilerOptions": {
    "allowJs": true,
    "incremental": true,
    "jsx": "preserve",
    "plugins": [{ "name": "next" }]
  }
}
```

- [ ] **Step 4: `packages/eslint-config`**

`package.json`:
```json
{
  "name": "@repo/eslint-config",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { "./base": "./base.mjs", "./next": "./next.mjs" },
  "dependencies": {
    "@eslint/js": "^9.0.0",
    "eslint-config-next": "16.3.3",
    "typescript-eslint": "^8.20.0"
  },
  "peerDependencies": { "eslint": "^9.0.0" }
}
```

`base.mjs`:
```js
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(js.configs.recommended, ...tseslint.configs.recommended, {
  ignores: ["dist/**", ".next/**", "node_modules/**"],
});
```

`next.mjs`:
```js
import next from "eslint-config-next";
import base from "./base.mjs";

export default [...base, ...next];
```

- [ ] **Step 5: Verify**

Run: `pnpm install && pnpm typecheck`
Expected: install succeeds; turbo reports `0 successful, 0 total` or "No tasks were executed" (no package defines `typecheck` yet) and exits 0.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "chore: scaffold turborepo workspace with shared ts and eslint configs"
```

---

### Task 2: `packages/ui` — brand, tokens, fonts, `cn`

**Files:**
- Create: `packages/ui/package.json`, `packages/ui/tsconfig.json`, `packages/ui/vitest.config.ts`
- Create: `packages/ui/src/brand.ts`, `packages/ui/src/cn.ts`, `packages/ui/src/cn.test.ts`, `packages/ui/src/tokens.css`
- Create: `packages/ui/fonts/Satoshi-Variable.woff2`, `packages/ui/fonts/Satoshi-VariableItalic.woff2` (copied)

**Interfaces:**
- Produces: `BRAND: string` from `@repo/ui/brand`; `cn(...inputs: ClassValue[]): string` from `@repo/ui/cn`; stylesheet `@repo/ui/tokens.css` defining every `--m-*` custom property for `:root` (light) and `.dark`; font files at `@repo/ui/fonts/*`.

- [ ] **Step 1: Package files**

`package.json`:
```json
{
  "name": "@repo/ui",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    "./brand": "./src/brand.ts",
    "./cn": "./src/cn.ts",
    "./tokens.css": "./src/tokens.css",
    "./fonts/*": "./fonts/*"
  },
  "scripts": { "typecheck": "tsc --noEmit", "lint": "eslint .", "test": "vitest run" },
  "dependencies": { "clsx": "^2.1.1", "tailwind-merge": "^3.0.2" },
  "devDependencies": {
    "@repo/eslint-config": "workspace:*",
    "@repo/typescript-config": "workspace:*",
    "eslint": "^9.0.0",
    "typescript": "^5.8.0",
    "vitest": "^2.1.9"
  }
}
```

`tsconfig.json`:
```json
{ "extends": "@repo/typescript-config/base.json", "include": ["src"] }
```

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({ test: { include: ["src/**/*.test.ts"] } });
```

`eslint.config.mjs`:
```js
export { default } from "@repo/eslint-config/base";
```

- [ ] **Step 2: Write the failing test** — `src/cn.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { cn } from "./cn";

describe("cn", () => {
  it("joins truthy class names", () => {
    expect(cn("a", false && "b", "c")).toBe("a c");
  });

  it("lets a later tailwind utility override an earlier conflicting one", () => {
    expect(cn("p-2", "p-4")).toBe("p-4");
  });
});
```

- [ ] **Step 3: Run it** — `pnpm install && pnpm --filter @repo/ui test`. Expected: FAIL, cannot resolve `./cn`.

- [ ] **Step 4: Implement**

`src/cn.ts`:
```ts
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
```

`src/brand.ts`:
```ts
// The one place the product name lives. Package names use the neutral @repo/*
// scope so a rename is this constant and nothing else.
export const BRAND = "AI Finance";
```

- [ ] **Step 5: Tokens and fonts**

```bash
SRC=/Users/hyungsukkang/iter-cx/iter-monorepo/apps/web
mkdir -p packages/ui/fonts
cp "$SRC/public/fonts/Satoshi-Variable.woff2" "$SRC/public/fonts/Satoshi-VariableItalic.woff2" packages/ui/fonts/
```

Create `src/tokens.css` from `$SRC/app/globals.css`: copy, verbatim and in this order, (a) the `:root {` block that starts at line 529, (b) the `.dark {` block that starts at line 808, (c) the `.dark {` block that starts at line 997. From each copied block delete every declaration whose property does **not** start with `--m-`. Do not change any value. Add this header comment as the first line:

```css
/* Monet design tokens, copied from iter-monorepo apps/web/app/globals.css. Values are not edited here. */
```

Verify: `grep -c -- "--m-primary:" packages/ui/src/tokens.css` prints `2` or `3` (light + dark), and `grep -v -- "--m-" packages/ui/src/tokens.css | grep ":" ` prints only selector lines, no other properties.

- [ ] **Step 6: Run** — `pnpm --filter @repo/ui test && pnpm --filter @repo/ui typecheck`. Expected: 2 tests pass; typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(ui): add brand constant, cn helper, Monet tokens and Satoshi fonts"
```

---

### Task 3: `packages/wallet` — config registry, passkey ceremony, session

**Files:**
- Create: `packages/wallet/package.json`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.mjs`
- Create: `packages/wallet/src/config.ts`, `src/config.test.ts`, `src/testing/fixture.ts`
- Copy + edit: `src/mera.ts`, `src/webauthnClient.ts`, `src/meraSession.ts`
- Copy + edit: `src/webauthnClient.test.ts`, `src/meraSession.test.ts`

**Interfaces:**
- Produces (`@repo/wallet/config`):
  ```ts
  type WalletConfig = {
    chains: readonly [Chain, ...Chain[]];            // order matters: chains[0] is the default for a new session
    brand: string;                                   // WebAuthn rp.name and the frame iframe title
    knownContracts: (chainId: number) => ReadonlySet<string>;  // lowercase addresses that are session-tier targets
  };
  function configureWallet(config: WalletConfig): void;
  function walletConfig(): WalletConfig;             // throws Error("Wallet is not configured — call configureWallet() first") when unset
  function walletChains(): readonly [Chain, ...Chain[]];
  function chainById(id: number): Chain;             // throws Error(`Chain ${id} is not configured`) when absent
  ```
- Produces (unchanged from Iter): `createPasskeyKey`, `unlockPasskeyKey`, `hasMeraCredential`, `forgetMeraCredential` from `./mera`; `prfKnownUnavailable`, `hintedWebAuthnClient` from `./webauthnClient`; `hasMeraSession`, `meraSessionAddress`, `meraSessionExpiry`, `saveMeraSession`, `restoreMeraSession`, `endMeraSession`, `SESSION_TTL_MS` from `./meraSession`.
- Produces (`src/testing/fixture.ts`): `TEST_CHAIN_A`, `TEST_CHAIN_B`, `configureTestWallet(known?: string[])`.

- [ ] **Step 1: Package files**

`package.json`:
```json
{
  "name": "@repo/wallet",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./config": "./src/config.ts",
    "./connectGate": "./src/connectGate.ts",
    "./walletFailure": "./src/walletFailure.ts",
    "./frame/client": "./src/frame/client.ts",
    "./frame/host": "./src/frame/host.ts",
    "./frame/signer": "./src/frame/signer.ts",
    "./frame/policy": "./src/frame/policy.ts",
    "./frame/protocol": "./src/frame/protocol.ts",
    "./frame/origins": "./src/frame/origins.ts"
  },
  "scripts": { "typecheck": "tsc --noEmit", "lint": "eslint .", "test": "vitest run" },
  "dependencies": { "@category-labs/mera": "0.2.0" },
  "peerDependencies": {
    "@tanstack/react-query": "^5.76.1",
    "react": "^19.0.0",
    "sonner": "^2.0.3",
    "viem": "^2.23.5",
    "wagmi": "^2.14.12"
  },
  "devDependencies": {
    "@repo/eslint-config": "workspace:*",
    "@repo/typescript-config": "workspace:*",
    "@tanstack/react-query": "^5.76.1",
    "@types/react": "^19.0.0",
    "eslint": "^9.0.0",
    "fake-indexeddb": "^6.0.0",
    "jsdom": "^30.0.1",
    "react": "^19.0.0",
    "sonner": "^2.0.3",
    "typescript": "^5.8.0",
    "viem": "^2.23.5",
    "vitest": "^2.1.9",
    "wagmi": "^2.14.12"
  }
}
```

`tsconfig.json`: `{ "extends": "@repo/typescript-config/base.json", "include": ["src"] }`

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

// A DOM is opted into per file with `// @vitest-environment jsdom`, as in the
// source repo: pure tests stay fast and a test that forgets the docblock fails loudly.
export default defineConfig({ test: { include: ["src/**/*.test.ts"] } });
```

`eslint.config.mjs`: `export { default } from "@repo/eslint-config/base";`

- [ ] **Step 2: Write the failing test** — `src/config.test.ts`

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

describe("wallet config", () => {
  beforeEach(() => vi.resetModules());

  it("throws before configureWallet is called", async () => {
    const { walletConfig } = await import("./config");
    expect(() => walletConfig()).toThrow("Wallet is not configured");
  });

  it("returns chains in the order given and finds one by id", async () => {
    const { configureWallet, walletChains, chainById } = await import("./config");
    const { TEST_CHAIN_A, TEST_CHAIN_B } = await import("./testing/fixture");
    configureWallet({ chains: [TEST_CHAIN_A, TEST_CHAIN_B], brand: "Test", knownContracts: () => new Set() });
    expect(walletChains().map((c) => c.id)).toEqual([TEST_CHAIN_A.id, TEST_CHAIN_B.id]);
    expect(chainById(TEST_CHAIN_B.id).name).toBe(TEST_CHAIN_B.name);
  });

  it("throws for a chain that is not configured", async () => {
    const { configureWallet, chainById } = await import("./config");
    const { TEST_CHAIN_A } = await import("./testing/fixture");
    configureWallet({ chains: [TEST_CHAIN_A], brand: "Test", knownContracts: () => new Set() });
    expect(() => chainById(1)).toThrow("Chain 1 is not configured");
  });
});
```

- [ ] **Step 3: Run** — `pnpm install && pnpm --filter @repo/wallet test`. Expected: FAIL, cannot resolve `./config`.

- [ ] **Step 4: Implement**

`src/config.ts`:
```ts
import type { Chain } from "viem";

/**
 * Everything the wallet needs to know about the app it is embedded in.
 *
 * Injected rather than imported so this package depends on nothing else in the
 * repo. BOTH the app and the wallet-frame pages must call `configureWallet`
 * with the same value at module load: the connector and the frame signer each
 * resolve chains, and they must agree.
 */
export type WalletConfig = {
  /** Order is load-bearing: `chains[0]` is the default for a new session. */
  chains: readonly [Chain, ...Chain[]];
  /** WebAuthn `rp.name` and the hidden iframe's title. */
  brand: string;
  /** Lowercase contract addresses on `chainId` whose calls may sign without a confirm click. */
  knownContracts: (chainId: number) => ReadonlySet<string>;
};

let current: WalletConfig | null = null;

export function configureWallet(config: WalletConfig): void {
  current = config;
}

export function walletConfig(): WalletConfig {
  if (!current) throw new Error("Wallet is not configured — call configureWallet() first");
  return current;
}

export function walletChains(): readonly [Chain, ...Chain[]] {
  return walletConfig().chains;
}

export function chainById(id: number): Chain {
  const chain = walletChains().find((c) => c.id === id);
  if (!chain) throw new Error(`Chain ${id} is not configured`);
  return chain;
}
```

`src/testing/fixture.ts`:
```ts
import { defineChain } from "viem";
import { configureWallet } from "../config";

export const TEST_CHAIN_A = defineChain({
  id: 900001,
  name: "Test A",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
});

export const TEST_CHAIN_B = defineChain({
  id: 900002,
  name: "Test B",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8546"] } },
});

/** Configure the wallet for a test. `known` are addresses treated as session-tier on TEST_CHAIN_A. */
export function configureTestWallet(known: string[] = []): void {
  const set = new Set(known.map((a) => a.toLowerCase()));
  configureWallet({
    chains: [TEST_CHAIN_A, TEST_CHAIN_B],
    brand: "Test Wallet",
    knownContracts: (chainId) => (chainId === TEST_CHAIN_A.id ? set : new Set()),
  });
}
```

- [ ] **Step 5: Run** — `pnpm --filter @repo/wallet test`. Expected: 3 pass.

- [ ] **Step 6: Copy the three key files and their tests**

```bash
SRC=/Users/hyungsukkang/iter-cx/iter-monorepo/apps/web/lib/wallet
cd packages/wallet/src
cp "$SRC/mera.ts" "$SRC/webauthnClient.ts" "$SRC/meraSession.ts" "$SRC/webauthnClient.test.ts" "$SRC/meraSession.test.ts" .
```

- [ ] **Step 7: Apply exactly these edits**

`mera.ts`:
| Find | Replace with |
|---|---|
| `const CREDENTIAL_KEY = "iter.mera-credential";` | `const CREDENTIAL_KEY = "wlt.mera-credential";` |
| `new TextEncoder().encode("iter.mera.v1.secp256k1.account\0\0")` | `new TextEncoder().encode("wlt1.mera.v1.secp256k1.account\0\0")` |
| `rp: { id: rpId(), name: "Iter" },` | `rp: { id: rpId(), name: walletConfig().brand },` |
| (add after the existing imports) | `import { walletConfig } from "./config";` |

`meraSession.ts`:
| Find | Replace with |
|---|---|
| `const SESSION_KEY = "iter.mera-session";` | `const SESSION_KEY = "wlt.mera-session";` |
| `const DB_NAME = "iter.mera";` | `const DB_NAME = "wlt.mera";` |

`webauthnClient.ts`: no edits.

In comments only, leave "Iter" wording alone except where a comment states one of the literal strings above; update those so comments stay true.

In the two test files: replace any literal `iter.mera-session`, `iter.mera-credential`, `iter.mera` with the `wlt.` equivalents. If `meraSession.test.ts` sets up IndexedDB through a package other than `fake-indexeddb`, keep its import as is and add that package to `devDependencies` at the version in `$SRC/../../package.json`.

- [ ] **Step 8: Guard the salt with a test** — create `src/mera.salt.test.ts`

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The PRF salt decides every user's address. Changing it orphans every wallet,
// so the literal is pinned by a test that reads the source text.
describe("PRF salt", () => {
  const source = readFileSync(fileURLToPath(new URL("./mera.ts", import.meta.url)), "utf8");

  it("is the fixed v1 literal", () => {
    expect(source).toContain('"wlt1.mera.v1.secp256k1.account\\0\\0"');
  });

  it("encodes to exactly 32 bytes", () => {
    expect(new TextEncoder().encode("wlt1.mera.v1.secp256k1.account\0\0").length).toBe(32);
  });
});
```

- [ ] **Step 9: Run** — `pnpm --filter @repo/wallet test && pnpm --filter @repo/wallet typecheck`.
Expected: `config`, `mera.salt`, `webauthnClient`, `meraSession` suites all pass; typecheck fails only on `./frame/client` missing from `mera.ts` (arrives in Task 4). If typecheck reports anything else, fix it before continuing.

- [ ] **Step 10: Commit**

```bash
git add -A && git commit -m "feat(wallet): port mera passkey ceremony and encrypted session with injected config"
```

---

### Task 4: `packages/wallet` — the isolated frame

**Files:**
- Copy + edit: `src/frame/{protocol,origins,client,host,signer,policy}.ts`
- Copy + edit: `src/frame/{protocol,origins,policy}.test.ts`

**Interfaces:**
- Consumes: `walletConfig`, `walletChains`, `chainById` from `../config`; `restoreMeraSession`, `endMeraSession` from `../meraSession`.
- Produces (unchanged names from Iter): `CHANNEL`, `PROTOCOL_VERSION`, `ERR`, `WalletFrameError`, `WalletRpc`, `FrameMethod`, `PresentParams`, guards from `./protocol`; `walletOrigin`, `appOrigins`, `isAllowedAppOrigin`, `appOrigin`, `isIsolated`, `walletFrameHost`, `FRAME_PATH`, `CONFIRM_PATH` from `./origins`; `WalletFrame`, `walletFrame` from `./client`; `startWalletFrameHost` from `./host`; `executeSigned` from `./signer`; `classify`, `describe`, `describeLines`, `knownContracts`, `messageText`, `CONFIRM_REQUIRED_ERROR`, `Tier`, `Classification`, `TokenMeta`, `shortAddress` from `./policy`.

- [ ] **Step 1: Copy**

```bash
SRC=/Users/hyungsukkang/iter-cx/iter-monorepo/apps/web/lib/wallet/frame
mkdir -p packages/wallet/src/frame && cd packages/wallet/src/frame
cp "$SRC"/{protocol,origins,client,host,signer,policy}.ts "$SRC"/{protocol,origins,policy}.test.ts .
```

- [ ] **Step 2: Edits**

`protocol.ts`:
- `export const CHANNEL = "iter.wallet-frame" as const;` → `export const CHANNEL = "wlt.wallet-frame" as const;`
- Remove `mera_sendBatch` from the `WalletRpc` method union and from any guard that lists allowed methods.

`client.ts`:
- `frame.title = "Iter wallet";` → `frame.title = \`${walletConfig().brand} wallet\`;`
- Add `import { walletConfig } from "../config";`

`signer.ts`:
- Delete `import { wagmiChains } from "@/lib/customChains";` and the local `function chainById(...) { ... }`; add `import { chainById } from "../config";`
- Delete the entire `case "mera_sendBatch": { ... }` block, the `BATCH_EXECUTOR_ABI` constant, and any import used only by them (`encodeFunctionData` if unused afterwards).

`policy.ts` — this file contains raw control bytes inside a regex (tools report it as binary; use `grep -a`):
- Delete `import { findChain } from "@iter/deployments";` and `import { wagmiChains } from "@/lib/customChains";`; add `import { walletConfig, walletChains } from "../config";`
- Replace the body of `knownContracts(chainId)` with: `return walletConfig().knownContracts(chainId);`
- Replace every remaining `wagmiChains` with `walletChains()`.
- In `messageText`, replace the regex line (the one under `// eslint-disable-next-line no-control-regex`) with the escaped, byte-identical form:
  ```ts
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(text)) return null;
  ```
  Then confirm no raw control bytes remain: `LC_ALL=C grep -c -a -P '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]' policy.ts` must print `0`, and `file policy.ts` must not say `data`.
- Remove every `mera_sendBatch` branch in `classify`, `describe`, and `describeLines`, and the `DescribedCall`/`Description` union members that exist only for batches. An unknown method must still fall through to `tier: "confirm"`.

`origins.ts`, `host.ts`: no edits.

Tests:
- `policy.test.ts`: remove any `vi.mock("@iter/deployments", …)` / `vi.mock("@/lib/customChains", …)`. Add at top: `import { configureTestWallet, TEST_CHAIN_A } from "../testing/fixture";`. In a `beforeEach`, call `configureTestWallet([<the address(es) the old mock registered as known>])`. Replace the old mocked chain id with `TEST_CHAIN_A.id`. Delete test cases that exercise `mera_sendBatch` only.
- Add one test to `policy.test.ts`:
  ```ts
  it("sends a removed batch method to the confirm tier", () => {
    const verdict = classify(TEST_CHAIN_A.id, { method: "mera_sendBatch", params: [] } as never);
    expect(verdict.tier).toBe("confirm");
  });
  ```
- `protocol.test.ts`: update the channel literal to `wlt.wallet-frame`; delete `mera_sendBatch`-only cases.

- [ ] **Step 3: Add a messageText regression test** to `policy.test.ts` (the regex was re-encoded, so pin its behaviour):

```ts
describe("messageText control characters", () => {
  it("accepts text with tab, newline and carriage return", () => {
    expect(messageText("line one\n\tline two\r\n")).toBe("line one\n\tline two\r\n");
  });

  it.each([0x00, 0x08, 0x0b, 0x0c, 0x0e, 0x1f, 0x7f])("rejects control byte 0x%s", (code) => {
    expect(messageText(`a${String.fromCharCode(code)}b`)).toBeNull();
  });
});
```

- [ ] **Step 4: Run** — `pnpm --filter @repo/wallet test && pnpm --filter @repo/wallet typecheck && pnpm --filter @repo/wallet lint`.
Expected: all suites pass; typecheck clean (the Task 3 `./frame/client` error is gone); lint clean.

- [ ] **Step 5: Confirm isolation** — `grep -rn "@/\|@iter/\|mera_sendBatch" packages/wallet/src --include=*.ts | grep -v "\.test\.ts"` must print nothing except the one test added above.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(wallet): port isolated key frame, signer and tier policy without batching"
```

---

### Task 5: `packages/wallet` — wagmi connector and React hooks

**Files:**
- Copy + edit: `src/meraConnector.ts`, `src/index.ts`, `src/walletFailure.ts`, `src/connectGate.ts`
- Copy + edit: `src/meraConnector.test.ts`, `src/walletFailure.test.ts`, `src/connectGate.test.ts`

**Interfaces:**
- Consumes: `walletChains`, `chainById` from `./config`; Task 3 and Task 4 exports.
- Produces: `MERA_CONNECTOR_ID = "mera"`, `meraConnector(params: { userName: () => string; frame?: WalletFrame }): CreateConnectorFn` from `./meraConnector`; from `.` (index): `useWalletAccount(): { address: \`0x${string}\` | undefined; isConnected: boolean; isAuthenticated: boolean; isLoading: boolean; hasSigner: boolean }`, `useWalletConnect(): { open(): void; fund(): void; disconnect(): void; ready: boolean }`, `describeConnectError`, `causeMessage`; `requestWalletConnect(reason: string)` and its listener hook from `./connectGate`.

- [ ] **Step 1: Copy**

```bash
SRC=/Users/hyungsukkang/iter-cx/iter-monorepo/apps/web/lib/wallet
cd packages/wallet/src
cp "$SRC"/{meraConnector,index,walletFailure,connectGate}.ts "$SRC"/{meraConnector,walletFailure,connectGate}.test.ts .
```

- [ ] **Step 2: Edits**

`meraConnector.ts`:
- Delete `import { wagmiChains } from "@/lib/customChains";` and the local `function chainById(...)`; add `import { chainById, walletChains } from "./config";`
- `let chainId: number = wagmiChains[0].id;` → `let chainId: number = walletChains()[0].id;`. If this line sits at module scope or runs before `configureWallet` could have been called, move the read inside the connector factory's returned function so it runs at connector creation, not at import.
- Remove `"mera_sendBatch"` from `SIGNING_METHODS`.

`index.ts`:
- `useWalletConnect().fund` navigates to a deposit route in Iter. Keep the function; make it call `window.location.assign("/deposit")`. Remove any import of Iter's i18n router or `next-intl` that this leaves unused.
- Remove any other import beginning with `@/`; if one remains, stop and report it rather than stubbing it.

`walletFailure.ts`, `connectGate.ts`: fix import paths only if they used `@/lib/wallet/...` (→ relative).

Tests: in `meraConnector.test.ts`, remove `vi.mock("@/lib/customChains", …)`; add `import { configureTestWallet, TEST_CHAIN_A, TEST_CHAIN_B } from "./testing/fixture";`, call `configureTestWallet()` in `beforeEach`, and replace mocked chain ids with `TEST_CHAIN_A.id` / `TEST_CHAIN_B.id`. Delete `mera_sendBatch`-only cases.

- [ ] **Step 3: Run** — `pnpm --filter @repo/wallet test && pnpm --filter @repo/wallet typecheck && pnpm --filter @repo/wallet lint`. Expected: all pass, clean.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(wallet): port mera wagmi connector, account hooks and failure copy"
```

---

### Task 6: `apps/web` — Next.js app, CSP, proxy, wallet-frame routes

**Files:**
- Create: `apps/web/package.json`, `tsconfig.json`, `next.config.ts`, `postcss.config.mjs`, `eslint.config.mjs`, `vitest.config.ts`, `.env.example`
- Create: `apps/web/lib/chains.ts`, `lib/walletSetup.ts`, `lib/fonts.ts`, `lib/providers.tsx`
- Copy + edit: `apps/web/lib/security/csp.ts`, `lib/security/csp.test.ts`
- Create: `apps/web/proxy.ts`, `apps/web/proxy.test.ts`
- Create: `apps/web/app/globals.css`, `app/(app)/layout.tsx`, `app/(app)/page.tsx`
- Copy + edit: `apps/web/app/wallet-frame/{layout.tsx,page.tsx,confirm/page.tsx,blocked/route.ts}`

**Interfaces:**
- Consumes: `configureWallet` (`@repo/wallet/config`), `meraConnector` (`@repo/wallet`), `startWalletFrameHost` (`@repo/wallet/frame/host`), origins helpers, `BRAND`, tokens, fonts.
- Produces: `appChains: readonly [Chain, ...Chain[]]` from `@/lib/chains` (Arc Testnet first, then RISE Testnet); side-effect module `@/lib/walletSetup` (import it for its effect); `wagmiConfig` and `<Providers>` from `@/lib/providers`; `satoshi`, `dmMono` from `@/lib/fonts`.

Two root layouts are used on purpose: `app/(app)/layout.tsx` for the product and `app/wallet-frame/layout.tsx` for the key pages, so nothing the app mounts ever runs on the wallet origin. There must be **no** `app/layout.tsx`.

- [ ] **Step 1: Package and config files**

`package.json`:
```json
{
  "name": "@repo/web",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "dev": "next dev --turbopack",
    "build": "next build",
    "start": "next start",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "e2e": "playwright test"
  },
  "dependencies": {
    "@repo/ui": "workspace:*",
    "@repo/wallet": "workspace:*",
    "@tanstack/react-query": "^5.76.1",
    "lucide-react": "^0.508.0",
    "next": "^16.3.4",
    "next-themes": "^0.4.6",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "sonner": "^2.0.3",
    "viem": "^2.23.5",
    "wagmi": "^2.14.12"
  },
  "devDependencies": {
    "@playwright/test": "^1.50.0",
    "@repo/eslint-config": "workspace:*",
    "@repo/typescript-config": "workspace:*",
    "@tailwindcss/postcss": "^4.0.9",
    "@types/node": "^22.0.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "eslint": "^9.0.0",
    "postcss": "^8.5.0",
    "tailwindcss": "^4.0.9",
    "tailwindcss-animate": "^1.0.7",
    "typescript": "^5.8.0",
    "vitest": "^2.1.9"
  }
}
```

`tsconfig.json`:
```json
{
  "extends": "@repo/typescript-config/next.json",
  "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./*"] } },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules", "e2e"]
}
```

`postcss.config.mjs`: `export default { plugins: { "@tailwindcss/postcss": {} } };`

`eslint.config.mjs`: `export { default } from "@repo/eslint-config/next";`

`vitest.config.ts`:
```ts
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./", import.meta.url)) } },
  test: { include: ["lib/**/*.test.ts", "proxy.test.ts"] },
});
```

`.env.example`:
```
# Where the wallet frame is served. Unset = same origin (local dev only, NOT isolated).
# Production: a separate origin, e.g. https://wallet.example.com
NEXT_PUBLIC_WALLET_ORIGIN=
# Comma-separated app origins the frame answers. Unset = own origin.
# Production: e.g. https://app.example.com
NEXT_PUBLIC_WALLET_APP_ORIGIN=
```

- [ ] **Step 2: Chains** — `lib/chains.ts`

Copy the two `defineChain` blocks verbatim from `/Users/hyungsukkang/iter-cx/iter-monorepo/apps/web/lib/customChains.ts`: `riseTestnet` (starts line 127) and `arcTestnet` (starts line 217), including their comments. The file is then exactly:

```ts
import { defineChain, type Chain } from "viem";

// <riseTestnet block, verbatim>

// <arcTestnet block, verbatim>

// Order is load-bearing: appChains[0] is the default chain for a new session.
export const appChains = [arcTestnet, riseTestnet] as const satisfies readonly [Chain, ...Chain[]];
```

Verify ids: `grep -n "id:" apps/web/lib/chains.ts` shows `5042002` and `11155931`.

- [ ] **Step 3: Wallet setup, fonts, providers**

`lib/walletSetup.ts`:
```ts
import { BRAND } from "@repo/ui/brand";
import { configureWallet } from "@repo/wallet/config";
import { appChains } from "./chains";

// Imported for its side effect by BOTH the app providers and every
// wallet-frame page, so the connector and the frame signer agree on chains.
// No contract is session-tier yet: protocol adapters register theirs in a later
// plan, and until then every value-moving request needs a click in the frame.
configureWallet({ chains: appChains, brand: BRAND, knownContracts: () => new Set<string>() });
```

`lib/fonts.ts`:
```ts
import localFont from "next/font/local";
import { DM_Mono } from "next/font/google";

export const satoshi = localFont({
  src: [
    { path: "../../../packages/ui/fonts/Satoshi-Variable.woff2", style: "normal" },
    { path: "../../../packages/ui/fonts/Satoshi-VariableItalic.woff2", style: "italic" },
  ],
  variable: "--font-satoshi",
  display: "swap",
});

export const dmMono = DM_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-dm-mono", display: "swap" });
```

`lib/providers.tsx`:
```tsx
"use client";

import "./walletSetup";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useEffect, useState, type ReactNode } from "react";
import { Toaster } from "sonner";
import { http } from "viem";
import { createConfig, useReconnect, WagmiProvider } from "wagmi";
import { meraConnector } from "@repo/wallet/meraConnector";
import { BRAND } from "@repo/ui/brand";
import { appChains } from "./chains";

export const wagmiConfig = createConfig({
  chains: appChains,
  connectors: [meraConnector({ userName: () => `${BRAND} wallet` })],
  // Load-bearing: EIP-6963 auto-discovery would otherwise promote an injected
  // wallet to the active account when the deposit sheet calls eth_requestAccounts.
  multiInjectedProviderDiscovery: false,
  transports: Object.fromEntries(appChains.map((c) => [c.id, http()])) as Record<(typeof appChains)[number]["id"], ReturnType<typeof http>>,
  ssr: true,
});

// WagmiProvider's own reconnect turns a rejection into an unhandled rejection;
// the hook turns it into mutation state instead.
function ReconnectOnMount() {
  const { reconnect } = useReconnect();
  useEffect(() => {
    reconnect();
  }, [reconnect]);
  return null;
}

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <WagmiProvider config={wagmiConfig} reconnectOnMount={false}>
        <QueryClientProvider client={queryClient}>
          <ReconnectOnMount />
          {children}
          <Toaster position="bottom-right" />
        </QueryClientProvider>
      </WagmiProvider>
    </ThemeProvider>
  );
}
```

Add `"./meraConnector": "./src/meraConnector.ts"` to the `exports` map in `packages/wallet/package.json`.

- [ ] **Step 4: CSP library**

```bash
SRC=/Users/hyungsukkang/iter-cx/iter-monorepo/apps/web/lib/security
mkdir -p apps/web/lib/security && cp "$SRC/csp.ts" "$SRC/csp.test.ts" apps/web/lib/security/
```

Edits to `csp.ts`: in `appCsp`, remove the two Vercel analytics origins from `connect` and ` https://va.vercel-scripts.com` from `script-src` (this app mounts no analytics); remove the two comments that describe them. Update `csp.test.ts` expectations that assert those hosts. Nothing else changes.

- [ ] **Step 5: Write the failing proxy test** — `proxy.test.ts`

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

async function load(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return (await import("./proxy")).default;
}

function req(url: string, host: string) {
  return new NextRequest(url, { headers: { host } });
}

afterEach(() => {
  delete process.env.NEXT_PUBLIC_WALLET_ORIGIN;
  delete process.env.NEXT_PUBLIC_WALLET_APP_ORIGIN;
});

describe("proxy", () => {
  it("serves the frame with an enforced strict CSP when no wallet origin is configured", async () => {
    const proxy = await load({ NEXT_PUBLIC_WALLET_ORIGIN: undefined });
    const res = proxy(req("http://localhost:3000/wallet-frame", "localhost:3000"));
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("refuses the frame on the app host when a wallet origin is configured", async () => {
    const proxy = await load({ NEXT_PUBLIC_WALLET_ORIGIN: "https://wallet.example.com" });
    const res = proxy(req("https://app.example.com/wallet-frame", "app.example.com"));
    expect(res.status).toBe(404);
  });

  it("refuses every non-frame path on the wallet host", async () => {
    const proxy = await load({ NEXT_PUBLIC_WALLET_ORIGIN: "https://wallet.example.com" });
    const res = proxy(req("https://wallet.example.com/", "wallet.example.com"));
    expect(res.status).toBe(404);
  });

  it("limits frame-ancestors to the configured app origins", async () => {
    const proxy = await load({
      NEXT_PUBLIC_WALLET_ORIGIN: "https://wallet.example.com",
      NEXT_PUBLIC_WALLET_APP_ORIGIN: "https://app.example.com",
    });
    const res = proxy(req("https://wallet.example.com/wallet-frame/confirm", "wallet.example.com"));
    expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors https://app.example.com");
  });

  it("allows the app to frame the wallet origin and connect to chain RPCs", async () => {
    const proxy = await load({ NEXT_PUBLIC_WALLET_ORIGIN: "https://wallet.example.com" });
    const res = proxy(req("https://app.example.com/", "app.example.com"));
    const csp = res.headers.get("Content-Security-Policy-Report-Only") ?? "";
    expect(csp).toContain("frame-src 'self' https://wallet.example.com");
    expect(csp).toContain("https://rpc.testnet.arc.network");
  });
});
```

- [ ] **Step 6: Run** — `pnpm install && pnpm --filter @repo/web test`. Expected: `csp.test.ts` passes; `proxy.test.ts` FAILS, cannot resolve `./proxy`.

- [ ] **Step 7: Implement** — `proxy.ts`

```ts
import { NextResponse, type NextRequest } from "next/server";
import { appOrigins, walletFrameHost, walletOrigin } from "@repo/wallet/frame/origins";
import { appChains } from "./lib/chains";
import { appCsp, newNonce, walletFrameCsp } from "./lib/security/csp";

const FRAME_PREFIX = "/wallet-frame";
const isDev = process.env.NODE_ENV === "development";

function requestHost(request: NextRequest): string {
  return request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "";
}

function rpcOrigins(): string[] {
  return Array.from(new Set(appChains.flatMap((chain) => chain.rpcUrls.default.http.map((url) => new URL(url).origin))));
}

/**
 * The frame pages: the strict policy, enforced. Next reads the nonce off the
 * REQUEST's CSP header when it renders and the browser reads it off the
 * RESPONSE's. Both, or the inline scripts Next emits carry no nonce and the
 * policy blocks the page it protects.
 */
function withWalletFrameHeaders(request: NextRequest): NextResponse {
  const nonce = newNonce();
  const csp = walletFrameCsp({ nonce, dev: isDev, appOrigins: appOrigins(), rpcOrigins: rpcOrigins() });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Cache-Control", "no-store");
  return response;
}

/**
 * The app pages: the full policy report-only. The ENFORCED header is not set
 * here: Next copies response headers a proxy sets back onto the request and
 * reads the nonce from `content-security-policy` first, so an enforced header
 * without a nonce would shadow the one with it. The enforced directives ride
 * `headers()` in next.config.ts instead.
 */
function withAppHeaders(request: NextRequest): NextResponse {
  const nonce = newNonce();
  const csp = appCsp({ nonce, dev: isDev, walletOrigin: walletOrigin(), connectOrigins: rpcOrigins() });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp.reportOnly);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy-Report-Only", csp.reportOnly);
  response.headers.set("Reporting-Endpoints", csp.reportingEndpoints);
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  return response;
}

export default function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  const walletHost = walletFrameHost();
  const host = requestHost(request);

  if (pathname === FRAME_PREFIX || pathname.startsWith(`${FRAME_PREFIX}/`)) {
    // Configured but asked for on the wrong host: not served. The app host must
    // not serve the frame (its storage would then be the app's).
    if (walletHost && host !== walletHost) return new NextResponse(null, { status: 404 });
    return withWalletFrameHeaders(request);
  }

  // Anything else on the wallet host is refused: that origin serves the frame and nothing else.
  if (walletHost && host === walletHost) return new NextResponse(null, { status: 404 });

  return withAppHeaders(request);
}

export const config = {
  // Everything except route handlers, framework internals, and any path with a dot (static files).
  matcher: ["/((?!api|_next|_vercel|.*\\..*).*)"],
};
```

`appCsp` names a report endpoint (`CSP_REPORT_PATH = "/api/csp-report"`). Create `app/api/csp-report/route.ts` so reports have somewhere to go:

```ts
// Browsers POST CSP violation reports here. Phase 1 acknowledges them; a later
// plan forwards them to logging.
export async function POST(): Promise<Response> {
  return new Response(null, { status: 204 });
}
```

- [ ] **Step 8: `next.config.ts`**

```ts
import type { NextConfig } from "next";
import { ENFORCED_META_CSP, FRAME_ANCESTORS_HEADER } from "./lib/security/csp";

const walletHost = (() => {
  const raw = process.env.NEXT_PUBLIC_WALLET_ORIGIN?.trim();
  if (!raw) return null;
  try {
    return new URL(raw).host || null;
  } catch {
    return null;
  }
})();

const config: NextConfig = {
  transpilePackages: ["@repo/ui", "@repo/wallet"],
  async headers() {
    return [
      {
        // The app's enforced directives. `/wallet-frame*` is EXCLUDED: those pages
        // are embedded by the app, and their own enforced CSP comes from proxy.ts.
        source: "/:path((?!wallet-frame(?:/|$)|_next/|api/).*)",
        headers: [{ key: "Content-Security-Policy", value: ENFORCED_META_CSP }, FRAME_ANCESTORS_HEADER],
      },
    ];
  },
  async rewrites() {
    // The wallet host serves the wallet frame and NOTHING else.
    const beforeFiles = walletHost
      ? [
          {
            source: "/:path((?!wallet-frame(?:/|$)|_next/).*)",
            has: [{ type: "host" as const, value: walletHost.replace(/\./g, "\\.") }],
            destination: "/wallet-frame/blocked",
          },
        ]
      : [];
    return { beforeFiles, afterFiles: [], fallback: [] };
  },
};

export default config;
```

- [ ] **Step 9: Styles and app layout**

`app/globals.css`:
```css
@import "tailwindcss";
@import "@repo/ui/tokens.css";

@plugin "tailwindcss-animate";

@custom-variant dark (&:is(.dark *));

@source "../../../packages/ui/src";
@source "../../../packages/wallet/src";

@theme inline {
  --font-satoshi: var(--font-satoshi);
  --font-dm-mono: var(--font-dm-mono);
}

body {
  background: var(--m-background);
  color: var(--m-text-primary);
}
```

`app/(app)/layout.tsx`:
```tsx
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { BRAND } from "@repo/ui/brand";
import { dmMono, satoshi } from "@/lib/fonts";
import { Providers } from "@/lib/providers";
import "../globals.css";

export const metadata: Metadata = { title: BRAND, description: "Trade, provide liquidity and launch coins by chatting." };

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${satoshi.variable} ${dmMono.variable}`}>
      <body className="font-satoshi antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
```

`app/(app)/page.tsx` (replaced in Task 7):
```tsx
import { BRAND } from "@repo/ui/brand";

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-[1080px] items-center justify-center p-6">
      <h1 className="text-2xl font-semibold">{BRAND}</h1>
    </main>
  );
}
```

- [ ] **Step 10: Wallet-frame routes**

```bash
SRC=/Users/hyungsukkang/iter-cx/iter-monorepo/apps/web/app/wallet-frame
mkdir -p apps/web/app/wallet-frame/confirm apps/web/app/wallet-frame/blocked
cp "$SRC/layout.tsx" "$SRC/page.tsx" apps/web/app/wallet-frame/
cp "$SRC/confirm/page.tsx" apps/web/app/wallet-frame/confirm/
cp "$SRC/blocked/route.ts" apps/web/app/wallet-frame/blocked/
```

Edits (imports only, plus setup):
- In `layout.tsx`, `page.tsx`, `confirm/page.tsx`: add `import "@/lib/walletSetup";` as the first import.
- `@/lib/wallet/frame/host` → `@repo/wallet/frame/host`; same mapping for `origins`, `policy`, `protocol`, `signer`.
- `confirm/page.tsx`: delete `import { wagmiChains } from "@/lib/customChains";`, add `import { appChains } from "@/lib/chains";`, and replace `wagmiChains` with `appChains`. Remove any branch that renders a `mera_sendBatch` description (its types no longer exist).
- `layout.tsx`: the `../globals.css` import path stays valid. Keep `export const dynamic = "force-dynamic";` and the comment block.

- [ ] **Step 11: Run**

```bash
pnpm --filter @repo/web test && pnpm typecheck && pnpm lint && pnpm --filter @repo/web build
```
Expected: csp + 5 proxy tests pass; typecheck and lint clean across the workspace; build succeeds and lists `/`, `/wallet-frame`, `/wallet-frame/confirm` (dynamic), `/wallet-frame/blocked`.

- [ ] **Step 12: Smoke check headers**

```bash
pnpm --filter @repo/web dev &   # then, once ready:
curl -sI http://localhost:3000/wallet-frame | grep -i "content-security-policy\|cache-control"
curl -sI http://localhost:3000/ | grep -i "content-security-policy"
```
Expected: the frame response has an enforced `content-security-policy` starting `default-src 'none'` and `cache-control: no-store`; the app response has `content-security-policy-report-only` and the short enforced `content-security-policy`. Stop the dev server afterwards.

- [ ] **Step 13: Commit**

```bash
git add -A && git commit -m "feat(web): add Next.js app with nonce CSP proxy and isolated wallet-frame routes"
```

---

### Task 7: Connect UI and end-to-end wallet test

**Files:**
- Copy + edit: `apps/web/components/wallet/ConnectWalletDialog.tsx`, `apps/web/components/wallet/WalletConfirmFrame.tsx`
- Create: `apps/web/components/wallet/WalletStatus.tsx`
- Modify: `apps/web/app/(app)/page.tsx`
- Create: `apps/web/playwright.config.ts`, `apps/web/e2e/wallet.spec.ts`

**Interfaces:**
- Consumes: `useWalletAccount`, `useWalletConnect` (`@repo/wallet`); connect-gate listener (`@repo/wallet/connectGate`); `walletFrame.status()` (`@repo/wallet/frame/client`); `cn` (`@repo/ui/cn`).
- Produces: `<ConnectWalletDialog />` (mount once in the layout tree), `<WalletConfirmFrame />` (used by Plan 2's withdraw), `<WalletStatus />` with test ids `connect-button`, `wallet-address`, `wallet-expiry`, `disconnect-button`.

- [ ] **Step 1: Copy components**

```bash
SRC=/Users/hyungsukkang/iter-cx/iter-monorepo/apps/web/components/Wallet
mkdir -p apps/web/components/wallet
cp "$SRC/ConnectWalletDialog.tsx" "$SRC/WalletConfirmFrame.tsx" apps/web/components/wallet/
```

Edits: `@/lib/wallet` → `@repo/wallet`; `@/lib/wallet/connectGate` → `@repo/wallet/connectGate`; `@/lib/wallet/frame/origins` and `/protocol` → `@repo/wallet/frame/origins` and `/protocol`; `import { cn } from "@/lib/utils"` → `import { cn } from "@repo/ui/cn"`. Replace the user-visible string "Iter" with `{BRAND}` (import from `@repo/ui/brand`) wherever it names the product; leave all other copy unchanged. If either file imports `next-intl`, replace each `t("…")` call with the English string from `$SRC/../../messages/en.json` for that key and remove the import.

- [ ] **Step 2: `WalletStatus.tsx`**

```tsx
"use client";

import { useEffect, useState } from "react";
import { useWalletAccount, useWalletConnect } from "@repo/wallet";
import { walletFrame } from "@repo/wallet/frame/client";

function formatExpiry(expiresAt: number | null): string {
  if (!expiresAt) return "";
  return new Date(expiresAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function WalletStatus() {
  const { address, isConnected, isLoading } = useWalletAccount();
  const { open, disconnect, ready } = useWalletConnect();
  const [expiresAt, setExpiresAt] = useState<number | null>(null);

  useEffect(() => {
    if (!isConnected) {
      setExpiresAt(null);
      return;
    }
    let cancelled = false;
    // status() never decrypts: it reports the address and absolute expiry only.
    walletFrame
      .status()
      .then((s) => {
        if (!cancelled) setExpiresAt(s.expiresAt ?? null);
      })
      .catch(() => {
        if (!cancelled) setExpiresAt(null);
      });
    return () => {
      cancelled = true;
    };
  }, [isConnected, address]);

  if (!isConnected || !address) {
    return (
      <button
        type="button"
        data-testid="connect-button"
        disabled={!ready || isLoading}
        onClick={open}
        className="min-h-11 rounded-xl bg-[color:var(--m-primary)] px-5 text-sm font-medium text-white transition-colors hover:bg-[color:var(--m-primary-hover)] disabled:opacity-60"
      >
        {isLoading ? "Connecting…" : "Continue with passkey"}
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-[color:var(--m-border)] bg-[color:var(--m-surface)] p-5">
      <span className="text-xs uppercase tracking-wide text-[color:var(--m-text-secondary)]">Your wallet</span>
      {/* Full address on purpose: a shortened one is not safe to copy funds to. */}
      <code data-testid="wallet-address" className="break-all font-dm-mono text-sm">
        {address}
      </code>
      <span data-testid="wallet-expiry" className="font-dm-mono text-xs text-[color:var(--m-text-secondary)]">
        {expiresAt ? `Session ends ${formatExpiry(expiresAt)}` : "Session active"}
      </span>
      <button
        type="button"
        data-testid="disconnect-button"
        onClick={disconnect}
        className="min-h-11 self-start rounded-xl border border-[color:var(--m-border)] px-4 text-sm"
      >
        Lock wallet
      </button>
    </div>
  );
}
```

If `--m-border` or `--m-text-secondary` is not defined in `packages/ui/src/tokens.css`, use the nearest token that is (check with `grep -- "--m-border\|--m-text-" packages/ui/src/tokens.css`) rather than inventing a value.

- [ ] **Step 3: Home page** — replace `app/(app)/page.tsx`

```tsx
import { BRAND } from "@repo/ui/brand";
import { ConnectWalletDialog } from "@/components/wallet/ConnectWalletDialog";
import { WalletStatus } from "@/components/wallet/WalletStatus";

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-[1080px] flex-col items-center justify-center gap-8 p-6">
      <h1 className="text-2xl font-semibold">{BRAND}</h1>
      <WalletStatus />
      <ConnectWalletDialog />
    </main>
  );
}
```

If `ConnectWalletDialog` is a default export in the copied file, import it as a default instead.

- [ ] **Step 4: Playwright config** — `playwright.config.ts`

```ts
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: false,
  retries: 0,
  use: { baseURL: "http://localhost:3100", trace: "retain-on-failure" },
  // Chromium only: the virtual authenticator with PRF is a Chrome DevTools Protocol feature.
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm exec next dev --turbopack --port 3100",
    url: "http://localhost:3100",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
```

- [ ] **Step 5: Write the E2E test** — `e2e/wallet.spec.ts`

```ts
import { expect, test, type Page } from "@playwright/test";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** A platform authenticator that auto-approves, with the PRF extension mera derives the key from. */
async function addPasskeyAuthenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      ctap2Version: "ctap2_1",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf: true,
      automaticPresenceSimulation: true,
    },
  });
  return cdp;
}

async function connect(page: Page) {
  await page.getByTestId("connect-button").click();
  // The dialog's primary action creates or unlocks the passkey.
  const primary = page.getByRole("dialog").getByRole("button").first();
  if (await primary.isVisible().catch(() => false)) await primary.click();
  await expect(page.getByTestId("wallet-address")).toHaveText(ADDRESS, { timeout: 30_000 });
}

test("creates a passkey wallet and shows the full address and session expiry", async ({ page }) => {
  await addPasskeyAuthenticator(page);
  await page.goto("/");
  await connect(page);
  await expect(page.getByTestId("wallet-expiry")).toContainText("Session");
});

test("resumes the session after reload without prompting, with the same address", async ({ page }) => {
  await addPasskeyAuthenticator(page);
  await page.goto("/");
  await connect(page);
  const before = await page.getByTestId("wallet-address").innerText();

  await page.reload();
  await expect(page.getByTestId("wallet-address")).toHaveText(before, { timeout: 30_000 });
});

test("locking the wallet then unlocking with the same passkey yields the same address", async ({ page }) => {
  await addPasskeyAuthenticator(page);
  await page.goto("/");
  await connect(page);
  const before = await page.getByTestId("wallet-address").innerText();

  await page.getByTestId("disconnect-button").click();
  await expect(page.getByTestId("connect-button")).toBeVisible();

  await connect(page);
  await expect(page.getByTestId("wallet-address")).toHaveText(before);
});

test("the key never reaches app-origin storage in plaintext", async ({ page }) => {
  await addPasskeyAuthenticator(page);
  await page.goto("/");
  await connect(page);
  const dump = await page.evaluate(() => JSON.stringify({ ...localStorage }));
  // The credential pointer and an encrypted session may be present; a 64-hex private key must not be.
  expect(dump).not.toMatch(/(^|[^0-9a-fA-F])(0x)?[0-9a-fA-F]{64}([^0-9a-fA-F]|$)/);
});
```

If the connect dialog needs a different click sequence than `connect()` performs, adjust `connect()` to match the dialog's real buttons (read `ConnectWalletDialog.tsx`); do not weaken the assertions.

- [ ] **Step 6: Run**

```bash
pnpm --filter @repo/web exec playwright install chromium
pnpm e2e
```
Expected: 4 passed. If `hasPrf` is rejected by the installed Chromium, upgrade `@playwright/test` to the latest 1.x and re-run; do not remove PRF from the test.

- [ ] **Step 7: Full gate**

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm --filter @repo/web build
grep -rn "test\.skip\|test\.only\|it\.skip\|it\.only\|describe\.only\|TODO\|FIXME" apps packages --include=*.ts --include=*.tsx -l | grep -v node_modules
```
Expected: everything green. The grep must print no file written new in this plan. A hit inside a file copied from iter-monorepo is acceptable only if the same line exists in the source file (check with `grep -n` against `$SRC`); report any such hits in the task summary rather than editing them.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat(web): add passkey connect UI and end-to-end wallet session tests"
```

---

## Self-review notes

- **Spec coverage (Plan 1 slice):** §4 layout → Tasks 1, 2, 3, 6. §5.2 ported files + constant changes → Tasks 3–5 (salt pinned by test). §5.2 "not ported" batch removal → Tasks 4–5 with a regression test. §5.4 frame routes and env → Task 6 (`/wallet-frame/rules` belongs to Plan 3 with the rule engine). §5.5 `Signer` seam → deferred to Plan 3, where a second consumer of it first exists; Plan 1 keeps the wagmi connector as the only signer, which the spec allows.
- **Deliberately out of this plan:** the new rule engine (Plan 1 ports Iter's static tier policy with an empty known-contract set, so every value-moving request requires a click — strictly safer than the final behaviour), protocols, deposit/withdraw, db, agent, chat.
- **Known judgement calls for the executor are bounded:** each "if X, do Y" names the single permitted response; none allows stubbing or skipping.
