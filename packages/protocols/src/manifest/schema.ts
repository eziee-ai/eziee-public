import { getAddress, maxUint256, parseAbiItem, toFunctionSelector, type AbiFunction, type AbiParameter, type Address } from "viem";
import { z } from "zod";
import { ProtocolError } from "../errors";

/**
 * The protocol manifest: the only thing the wallet frame believes about a
 * protocol (spec §15, docs/protocol-integration/mcp-guideline.md §4).
 *
 * Validation is strict on purpose. A manifest that parses is one the decoder
 * can run without a single runtime type check, and every rule here is a way a
 * reviewed file could otherwise mean something different from what it says.
 */

const MAX_CALLS_PER_ACTION = 4;

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "not a 20-byte hex address")
  .refine((value) => {
    try {
      return getAddress(value) === value;
    } catch {
      return false;
    }
  }, "address is not EIP-55 checksummed")
  .transform((value) => value as Address);

const chainKey = z.string().regex(/^[1-9][0-9]*$/, "chain ids are decimal strings");
const uintString = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,77})$/, "expected a decimal integer string that fits uint256")
  .refine((value) => BigInt(value) <= maxUint256, "value does not fit uint256");

const argRef = z.object({ arg: z.string().min(1) }).strict();
const tokenRef = z.union([argRef, z.object({ const: address }).strict(), z.literal("native")]);
const amountRef = z.union([argRef, z.object({ const: uintString }).strict(), z.literal("msg.value")]);

const call = z
  .object({
    contract: z.string().min(1),
    abi: z.string().min(1),
    spend: z.array(z.object({ token: tokenRef, amount: amountRef }).strict()).optional(),
    receive: z.object({ token: tokenRef, minAmount: amountRef.optional() }).strict().optional(),
    recipient: argRef.optional(),
    deadline: argRef.optional(),
    /**
     * Address inputs the decoder deliberately does not interpret. Every address a
     * call takes must be the recipient, a spend/receive token, or listed
     * here with a reason a reviewer can weigh (e.g. a referral tag that never
     * receives funds). An unexplained address is where funds get redirected.
     */
    ignore: z.array(z.object({ arg: z.string().min(1), reason: z.string().min(20, "give a reason a reviewer can weigh (20+ characters)").max(200) }).strict()).optional(),
  })
  .strict();

const action = z
  .object({
    title: z.string().min(1).max(40),
    spends: z.boolean(),
    /**
     * This action is confirmed by the person every time and no rule may cover it. For an action that can give
     * something up which no spend amount describes: closing a position early and forfeiting what had not vested.
     */
    alwaysAsk: z.literal(true).optional(),
    /**
     * ALTERNATIVES, not a sequence: an action is ONE transaction, which must match exactly one of these (a limit
     * order is `limitBuy` or `limitSell`). A flow that needs several protocol calls in a row is several actions.
     */
    calls: z.array(call).min(1).max(MAX_CALLS_PER_ACTION, `an action has at most ${MAX_CALLS_PER_ACTION} calls`),
  })
  .strict();

const proxy = z.union([
  z.object({ type: z.literal("none") }).strict(),
  z.object({ type: z.enum(["uups", "transparent", "beacon", "clone"]), admin: address.optional() }).strict(),
]);

const contract = z
  .object({
    address,
    role: z.enum(["router", "pool-manager", "factory", "other"]),
    source: z.string().url(),
    proxy,
  })
  .strict();

const token = z
  .object({
    address,
    symbol: z.string().min(1).max(16),
    name: z.string().min(1).max(64),
    decimals: z.number().int().min(0).max(36),
    trust: z.enum(["canonical", "listed"]),
  })
  .strict();

export const manifestSchema = z
  .object({
    manifestVersion: z.literal(1, { errorMap: () => ({ message: "unsupported manifestVersion (expected 1)" }) }),
    id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,31}$/, "id must be lowercase [a-z0-9-], at most 32 chars")
      // Rate's old id. Saved chats and wallet rules under it are read as Rate's, so no other protocol may ever take it.
      .refine((id) => id !== "iter", "the id \"iter\" is reserved: it is Rate's former id"),
    name: z.string().min(1).max(40),
    version: z.string().regex(/^\d+\.\d+\.\d+$/, "version is semver"),
    homepage: z.string().url(),
    icon: z.string().optional(),
    mcp: z.object({ url: z.string().url(), transport: z.literal("streamable-http") }).strict().optional(),
    chains: z.array(z.number().int().positive()).min(1),
    contracts: z.record(chainKey, z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/), contract)),
    tokens: z.record(chainKey, z.array(token)),
    actions: z.record(z.string().regex(/^[a-z][a-zA-Z0-9]*$/), action),
  })
  .strict();

export type Manifest = z.infer<typeof manifestSchema>;
export type ManifestAction = z.infer<typeof action>;
export type ManifestCall = z.infer<typeof call>;
export type ManifestTokenRef = z.infer<typeof tokenRef>;
export type ManifestAmountRef = z.infer<typeof amountRef>;

/** The ABI function a call names, or a reason it is not one. */
export function callFunction(abi: string): AbiFunction {
  const item = parseAbiItem(abi);
  if (item.type !== "function") throw new Error("abi must be a function signature");
  return item;
}

/** The ABI parameter a (possibly dotted) arg path names, walking tuple components. */
export function resolveArg(fn: AbiFunction, path: string): AbiParameter | undefined {
  const [head, ...rest] = path.split(".");
  let current: AbiParameter | undefined = fn.inputs.find((input) => input.name === head);
  for (const part of rest) {
    const components: readonly AbiParameter[] | undefined =
      current && current.type === "tuple" && "components" in current ? current.components : undefined;
    current = components?.find((component) => component.name === part);
  }
  return current;
}

function isUint(type: string): boolean {
  return /^uint(8|16|24|32|40|48|56|64|72|80|88|96|104|112|120|128|136|144|152|160|168|176|184|192|200|208|216|224|232|240|248|256)?$/.test(type);
}

/** Every leaf input path with its type, walking tuple components: `to`, `params.tokenOut`, ... */
function leafInputs(params: readonly AbiParameter[], prefix = ""): Array<{ path: string; type: string }> {
  return params.flatMap((param) => {
    const path = `${prefix}${param.name ?? ""}`;
    if (param.type === "tuple" && "components" in param) return leafInputs(param.components, `${path}.`);
    // An ARRAY of tuples cannot be walked by an argument path, so an address inside one can be pinned to nothing.
    // The whole array is reported as one address-bearing input, which a reviewer must then explain under `ignore`.
    if (param.type.startsWith("tuple[") && "components" in param && leafInputs(param.components).some((leaf) => leaf.type.startsWith("address"))) return [{ path, type: "address-bearing tuple[]" }];
    return [{ path, type: param.type }];
  });
}

/** Problems with input NAMES: an unnamed or repeated name makes an arg ref resolve to the wrong value silently. */
function namingProblems(params: readonly AbiParameter[], prefix = ""): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const param of params) {
    if (!param.name) problems.push(`unnamed input of type ${param.type}${prefix ? ` in ${prefix.slice(0, -1)}` : ""}`);
    else if (seen.has(param.name)) problems.push(`duplicate input name "${prefix}${param.name}"`);
    if (param.name) seen.add(param.name);
    if (param.type.startsWith("tuple") && "components" in param) problems.push(...namingProblems(param.components, `${prefix}${param.name ?? ""}.`));
  }
  return problems;
}

/** The cross-field rules zod's shape cannot express. Returns human-readable problems. */
function crossCheck(m: Manifest): string[] {
  const problems: string[] = [];
  const chains = new Set(m.chains.map(String));

  for (const chainId of Object.keys(m.contracts)) if (!chains.has(chainId)) problems.push(`contracts listed for chain ${chainId}, which is not in chains`);
  for (const chainId of Object.keys(m.tokens)) if (!chains.has(chainId)) problems.push(`tokens listed for chain ${chainId}, which is not in chains`);

  for (const [chainId, tokens] of Object.entries(m.tokens)) {
    const seen = new Set<string>();
    for (const t of tokens) {
      const key = t.address.toLowerCase();
      if (seen.has(key)) problems.push(`duplicate token ${t.address} on chain ${chainId}`);
      seen.add(key);
    }
  }

  // One selector may mean one thing per contract key, or decoding is ambiguous.
  const selectors = new Map<string, string>();

  for (const [actionName, a] of Object.entries(m.actions)) {
    let spendEntries = 0;

    a.calls.forEach((c, index) => {
      const where = `actions.${actionName}.calls[${index}]`;
      for (const chainId of m.chains) {
        if (!m.contracts[String(chainId)]?.[c.contract]) problems.push(`${where}: unknown contract "${c.contract}" on chain ${chainId}`);
      }

      let fn: AbiFunction;
      try {
        fn = callFunction(c.abi);
      } catch (error) {
        problems.push(`${where}: abi does not parse as a function (${error instanceof Error ? error.message : String(error)})`);
        return;
      }

      const selectorKey = `${c.contract}:${toFunctionSelector(fn)}`;
      const owner = selectors.get(selectorKey);
      if (owner) problems.push(`${where}: selector ${toFunctionSelector(fn)} on "${c.contract}" is already claimed by ${owner}`);
      else selectors.set(selectorKey, where);

      for (const problem of namingProblems(fn.inputs)) problems.push(`${where}: ${problem}`);

      const expect = (ref: unknown, kind: "address" | "uint", label: string) => {
        if (typeof ref !== "object" || ref === null || !("arg" in ref)) return;
        const path = (ref as { arg: string }).arg;
        const param = resolveArg(fn, path);
        if (!param) problems.push(`${where}.${label}: "${path}" is not an input of ${fn.name}`);
        else if (kind === "address" && param.type !== "address") problems.push(`${where}.${label}: "${path}" is ${param.type}, expected address`);
        else if (kind === "uint" && !isUint(param.type)) problems.push(`${where}.${label}: "${path}" is ${param.type}, expected a uint`);
      };

      for (const [i, s] of (c.spend ?? []).entries()) {
        spendEntries += 1;
        expect(s.token, "address", `spend[${i}].token`);
        expect(s.amount, "uint", `spend[${i}].amount`);
        if (s.amount === "msg.value" && fn.stateMutability !== "payable") problems.push(`${where}.spend[${i}]: msg.value needs a payable function`);
        if (s.amount === "msg.value" && s.token !== "native") problems.push(`${where}.spend[${i}]: msg.value can only spend the native token`);
      }
      if (c.receive) {
        expect(c.receive.token, "address", "receive.token");
        expect(c.receive.minAmount, "uint", "receive.minAmount");
        if (c.receive.minAmount === "msg.value") problems.push(`${where}.receive.minAmount: msg.value is not a received amount`);
      }
      expect(c.recipient, "address", "recipient");
      expect(c.deadline, "uint", "deadline");

      const leaves = leafInputs(fn.inputs);
      for (const [i, entry] of (c.ignore ?? []).entries()) {
        if (!leaves.some((leaf) => leaf.path === entry.arg)) problems.push(`${where}.ignore[${i}]: "${entry.arg}" is not an input of ${fn.name}`);
      }

      // Every address the contract is handed must be explained, in EVERY call. An unexplained one is exactly
      // where output, refunds or fees get redirected. A call that spends nothing is no exception: withdrawing
      // a position or claiming fees spends nothing and still pays out to an address in its arguments.
      {
        const argOf = (ref: unknown): string | undefined => (typeof ref === "object" && ref !== null && "arg" in ref ? (ref as { arg: string }).arg : undefined);
        const accounted = new Set(
          [argOf(c.recipient), argOf(c.receive?.token), ...(c.spend ?? []).map((entry) => argOf(entry.token)), ...(c.ignore ?? []).map((entry) => entry.arg)].filter((path): path is string => path !== undefined),
        );
        for (const leaf of leaves) {
          if (leaf.type.startsWith("address") && !accounted.has(leaf.path)) {
            problems.push(`${where}: address input "${leaf.path}" is not accounted for (make it the recipient, a spend or receive token, or list it under ignore with a reason)`);
          }
          if (leaf.type === "address-bearing tuple[]" && !accounted.has(leaf.path)) {
            problems.push(`${where}: input "${leaf.path}" carries addresses inside an array, where none of them can be pinned. List it under ignore with the reason a reviewer should accept that`);
          }
        }
      }
    });

    if (a.spends && spendEntries === 0) problems.push(`actions.${actionName}: spends is true but no call declares a spend`);
    if (!a.spends && spendEntries > 0) problems.push(`actions.${actionName}: spends is false but a call declares a spend`);
  }

  return problems;
}

/** Parse and fully validate. Throws `ProtocolError("INVALID_MANIFEST")` listing every problem found. */
export function parseManifest(input: unknown): Manifest {
  const result = manifestSchema.safeParse(input);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
    throw new ProtocolError("INVALID_MANIFEST", problems.join("; "));
  }
  const problems = crossCheck(result.data);
  if (problems.length > 0) throw new ProtocolError("INVALID_MANIFEST", problems.join("; "));
  return result.data;
}
