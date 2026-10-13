import { decodeFunctionData, encodeFunctionData, erc20Abi, type Address, type Hex, type PublicClient } from "viem";
import { describe, expect, it, vi } from "vitest";
import { createRegistry } from "../registry";
import type { TxRequest } from "../types";
import { BandPositionManagerABI } from "./abis";
import { decodeRateAddLiquidity, isUnguardedRateWithdrawal } from "./decodeLiquidity";
import { createRateAdapter, decodeRateWithChain } from "./index";
import { rateManifest } from "./manifest";

const ARC = 5042002;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const ALICE = "0x0000000000000000000000000000000000001001" as Address;
const MALLORY = "0x0000000000000000000000000000000000001002" as Address;
const POOL = "0x0000000000000000000000000000000000005001" as Address;
const FAKE_POOL = "0x0000000000000000000000000000000000005002" as Address;
const LAUNCHED = "0x0000000000000000000000000000000000002001" as Address;
const contracts = rateManifest.contracts[String(ARC)]!;
const MANAGER = contracts.positionManager!.address;
const FACTORY = contracts.bandPoolFactory!.address;
const [USDC, EURC] = rateManifest.tokens[String(ARC)]!.map((t) => t.address) as [Address, Address];

interface Band {
  /** The band's live tolerance, both sides alike: zero means it quotes nothing right now. */
  tolerance: number;
  shares: bigint;
  open: boolean;
  base: bigint;
  quote: bigint;
}

/** A chain with one genuine pool (base EURC, quote USDC), its bands, and one position (#7) held by ALICE. */
function chain(options: { allowance?: bigint; poolBase?: Address; factoryPool?: Address; bands?: Band[]; holder?: Address; limit?: number; withdrawable?: readonly [bigint, bigint] | null } = {}) {
  const base = options.poolBase ?? EURC;
  const bands = options.bands ?? [
    { tolerance: 100_000, shares: 1_000_000n, open: true, base: 1_000_000n, quote: 2_000_000n },
    { tolerance: 300_000, shares: 0n, open: true, base: 0n, quote: 0n },
    { tolerance: 500_000, shares: 5n, open: false, base: 5n, quote: 5n },
  ];
  const readContract = vi.fn(async ({ address, functionName, args }: { address: Address; functionName: string; args?: readonly unknown[] }) => {
    const at = address.toLowerCase();
    if (functionName === "base") return base;
    if (functionName === "quote") return USDC;
    if (functionName === "getPool" && at === FACTORY.toLowerCase()) {
      const [a, b] = args as [Address, Address];
      return a.toLowerCase() === base.toLowerCase() && b.toLowerCase() === USDC.toLowerCase() ? (options.factoryPool ?? POOL) : ZERO;
    }
    if (functionName === "pairLimit") return options.limit ?? 400_000; // 0.4% either way
    if (functionName === "bandCount") return BigInt(bands.length);
    if (functionName === "DENOM") return 100_000_000; // the deployed value (PoolBands.sol)
    if (functionName === "bands") {
      const band = bands[Number((args as [number])[0])]!;
      return [band.tolerance, band.shares, 0n, 0n, band.open]; // [spreadFrac, shares, feeGrowthBase, feeGrowthQuote, open]
    }
    if (functionName === "bandReserves") {
      const band = bands[Number((args as [number])[0])]!;
      return [band.base, band.quote];
    }
    if (functionName === "bandTolerances") {
      const band = bands[Number((args as [number])[0])]!;
      return [band.tolerance, band.tolerance];
    }
    if (functionName === "holderOf") return options.holder ?? ALICE;
    if (functionName === "positionOf") {
      const slot = (band: number, open: boolean, principal: [bigint, bigint], pending: [bigint, bigint], vested: [bigint, bigint]) => ({ band, spreadFrac: 0, toleranceBuy: 0, toleranceSell: 0, feeMultiplier: 0, open, shares: 500n, bandShares: 1_000_000n, createdAt: 1n, baseOwned: principal[0], quoteOwned: principal[1], pendingBase: pending[0], pendingQuote: pending[1], vestedBase: vested[0], vestedQuote: vested[1], vestedNum: 800_000 });
      return { tokenId: 7n, pool: POOL, base: EURC, quote: USDC, holder: options.holder ?? ALICE, mintedAt: 1n, bandMask: 3, bands: [slot(0, true, [500n, 1_000n], [3n, 6n], [2n, 4n]), slot(1, false, [100n, 200n], [1n, 2n], [0n, 0n])], owedBase: 2n, owedQuote: 4n };
    }
    if (functionName === "allowance") return options.allowance ?? 0n;
    if (functionName === "decimals") return at === LAUNCHED.toLowerCase() ? 18 : 6;
    throw new Error(`unexpected read ${functionName} on ${address}`);
  });
  const call = vi.fn(async () => ({ data: "0x" as Hex }));
  // What `decreaseLiquidity` would pay out now, as the wallet would simulate it; null is a withdrawal that reverts.
  const simulateContract = vi.fn(async () => {
    const out = options.withdrawable === undefined ? ([1_000n, 2_000n] as const) : options.withdrawable;
    if (out === null) throw new Error("execution reverted");
    return { result: out };
  });
  return { client: { readContract, call, simulateContract } as unknown as PublicClient, readContract, call, simulateContract };
}

const DEADLINE = 2_000_000_000n;
const soon = () => BigInt(Math.floor(Date.now() / 1000)) + 1_200n;
const mintData = (pool: Address, bands: number[], baseAmounts: bigint[], quoteAmounts: bigint[], recipient: Address = ALICE, floor = 1n, deadline = soon()) =>
  encodeFunctionData({ abi: BandPositionManagerABI, functionName: "mint", args: [{ pool, bands, baseAmounts, quoteAmounts, minShares: bands.map(() => floor), recipient, deadline }] });
const addData = (pool: Address, band: number, baseAmount: bigint, quoteAmount: bigint) => mintData(pool, [band], [baseAmount], [quoteAmount]);
const tx = (to: Address, data: Hex, value = 0n): TxRequest => ({ chainId: ARC, to, data, value });
const adapter = createRateAdapter();
const ctx = (client: PublicClient) => ({ chainId: ARC, client, account: ALICE });

describe("decodeRateAddLiquidity — the call names a pool, so the pool must be proven genuine", () => {
  it("decodes a deposit as TWO spends and no promised return", async () => {
    const { client } = chain();
    expect(await decodeRateAddLiquidity(tx(MANAGER, addData(POOL, 0, 1_000_000n, 2_000_000n)), ALICE, client)).toEqual({
      protocol: "rate", action: "addLiquidity", chainId: ARC, contract: "positionManager", spends: true,
      spend: [
        { token: EURC, amount: 1_000_000n, listed: true },
        { token: USDC, amount: 2_000_000n, listed: true },
      ],
      recipient: ALICE, unlisted: false,
      venue: { pool: POOL, band: 0 },
    });
  });

  it("refuses a pool the factory does not vouch for, however it describes itself", async () => {
    const { client } = chain();
    expect(await decodeRateAddLiquidity(tx(MANAGER, addData(FAKE_POOL, 0, 1n, 1n)), ALICE, client)).toBeNull();
  });

  it("flags a launched coin as unlisted instead of hiding the deposit", async () => {
    const { client } = chain({ poolBase: LAUNCHED });
    expect(await decodeRateAddLiquidity(tx(MANAGER, addData(POOL, 0, 5n, 6n)), ALICE, client)).toMatchObject({ unlisted: true, spend: [{ token: LAUNCHED, amount: 5n, listed: false }, { token: USDC, amount: 6n, listed: true }] });
  });

  it.each([
    ["another contract", () => tx(POOL, addData(POOL, 0, 1n, 1n))],
    ["attached value", () => tx(MANAGER, addData(POOL, 0, 1n, 1n), 1n)],
    ["nothing deposited", () => tx(MANAGER, addData(POOL, 0, 0n, 0n))],
    // The honest builder never produces these. One token spent would make it eligible for a rule, which a two-token deposit never is.
    ["nothing on the base side", () => tx(MANAGER, addData(POOL, 0, 0n, 5n))],
    ["nothing on the quote side", () => tx(MANAGER, addData(POOL, 0, 5n, 0n))],
    ["appended bytes", () => tx(MANAGER, `${addData(POOL, 0, 1n, 1n)}00` as Hex)],
    // The position belongs to whoever `recipient` names: a mint for anyone but the signer pays for someone else's position.
    ["a position minted to someone else", () => tx(MANAGER, mintData(POOL, [0], [1n], [1n], MALLORY))],
    // The builder deposits into one band; a ladder of bands is a deposit nobody reviewed here.
    ["more than one band", () => tx(MANAGER, mintData(POOL, [0, 1], [1n, 1n], [1n, 1n]))],
    // The card shows neither, so they are held to what the builder makes.
    ["a zero share floor", () => tx(MANAGER, mintData(POOL, [0], [1n], [1n], ALICE, 0n))],
    ["a deadline already passed", () => tx(MANAGER, mintData(POOL, [0], [1n], [1n], ALICE, 1n, BigInt(Math.floor(Date.now() / 1000)) - 1n))],
    ["a deadline more than an hour away", () => tx(MANAGER, mintData(POOL, [0], [1n], [1n], ALICE, 1n, DEADLINE))],
    ["another function", () => tx(MANAGER, encodeFunctionData({ abi: BandPositionManagerABI, functionName: "burn", args: [1n] }))],
  ])("is null for %s", async (_name, make) => {
    const { client } = chain();
    expect(await decodeRateAddLiquidity(make(), ALICE, client)).toBeNull();
  });

  it("is null, never a throw, when the chain cannot be read", async () => {
    const client = { readContract: vi.fn(async () => Promise.reject(new Error("rpc down"))) } as unknown as PublicClient;
    expect(await decodeRateAddLiquidity(tx(MANAGER, addData(POOL, 0, 1n, 1n)), ALICE, client)).toBeNull();
  });

  it("is reached through the adapter's one chain decoder, after the swap decoder declines", async () => {
    const { client } = chain();
    expect(await decodeRateWithChain(tx(MANAGER, addData(POOL, 0, 1n, 1n)), ALICE, client)).toMatchObject({ action: "addLiquidity" });
    expect(await adapter.decodeWithChain!(tx(MANAGER, addData(POOL, 0, 1n, 1n)), ALICE, client)).toMatchObject({ action: "addLiquidity" });
  });
});

describe("addLiquidity.build", () => {
  const intent = { base: EURC, quote: USDC, band: 0, baseAmount: "1", quoteAmount: "2" };

  it("approves each token for exactly its amount, to the position manager, then deposits; and every step decodes back", async () => {
    const { client } = chain();
    const txs = await adapter.actions.addLiquidity!.build(adapter.actions.addLiquidity!.intent.parse(intent), ctx(client));
    expect(txs).toHaveLength(3);
    const registry = createRegistry([rateManifest]);
    expect(registry.decodeApproval(txs[0]!)).toMatchObject({ token: EURC, spender: MANAGER, amount: 1_000_000n });
    expect(registry.decodeApproval(txs[1]!)).toMatchObject({ token: USDC, spender: MANAGER, amount: 2_000_000n });
    expect(decodeFunctionData({ abi: erc20Abi, data: txs[0]!.data }).functionName).toBe("approve");
    expect(await decodeRateAddLiquidity(txs[2]!, ALICE, client)).toMatchObject({ action: "addLiquidity", spend: [{ token: EURC, amount: 1_000_000n }, { token: USDC, amount: 2_000_000n }] });
  });

  it("mints to the signer, demands 99.5% of the shares expected now, and expires in 20 minutes", async () => {
    const { client } = chain();
    const before = BigInt(Math.floor(Date.now() / 1000));
    const txs = await adapter.actions.addLiquidity!.build(adapter.actions.addLiquidity!.intent.parse(intent), ctx(client));
    const { args } = decodeFunctionData({ abi: BandPositionManagerABI, data: txs[2]!.data });
    const [p] = args as unknown as [{ pool: Address; bands: number[]; minShares: bigint[]; recipient: Address; deadline: bigint }];
    // Band 0 holds 1,000,000 shares over 1 EURC : 2 USDC, so 1 EURC + 2 USDC mints 1,000,000 shares.
    expect(p).toMatchObject({ pool: POOL, bands: [0], minShares: [995_000n], recipient: ALICE });
    expect(p.deadline - before).toBeGreaterThanOrEqual(1_200n);
    expect(p.deadline - before).toBeLessThanOrEqual(1_201n);
  });

  it("skips an approval the allowance already covers", async () => {
    const { client } = chain({ allowance: 10n ** 30n });
    expect(await adapter.actions.addLiquidity!.build(adapter.actions.addLiquidity!.intent.parse(intent), ctx(client))).toHaveLength(1);
  });

  it("accepts a first deposit into an empty band: it sets the ratio", async () => {
    const { client } = chain();
    expect(await adapter.actions.addLiquidity!.build(adapter.actions.addLiquidity!.intent.parse({ ...intent, band: 1 }), ctx(client))).toHaveLength(3);
  });

  it.each([
    ["a band that does not exist", { ...intent, band: 3 }, /band 3/],
    ["a closed band", { ...intent, band: 2 }, /closed/],
    ["the pair the wrong way round", { ...intent, base: USDC, quote: EURC }, /other way round/],
    ["a pair with no pool", { ...intent, base: LAUNCHED }, /no pool/],
    ["an amount too small to mint a share", { ...intent, baseAmount: "0.000001", quoteAmount: "0.000001" }, /too small/],
  ])("refuses %s", async (_name, bad, message) => {
    // Band 0 holds 1:2, so one base unit of each token mints min(1, 0) = 0 shares.
    const { client } = chain();
    await expect(adapter.actions.addLiquidity!.build(adapter.actions.addLiquidity!.intent.parse(bad), ctx(client))).rejects.toThrow(message);
  });

  it("takes a deposit into a band that quotes nothing yet: bands are fractions of the pair's limit, never beyond it", async () => {
    const idle = [{ tolerance: 0, shares: 0n, open: true, base: 0n, quote: 0n }];
    await expect(adapter.actions.addLiquidity!.build(adapter.actions.addLiquidity!.intent.parse(intent), ctx(chain({ bands: idle, limit: 0 }).client))).resolves.toHaveLength(3);
  });

  it("refuses an intent with nothing on one side, which the pool would silently refund", () => {
    expect(() => adapter.actions.addLiquidity!.intent.parse({ ...intent, quoteAmount: "0" })).toThrow();
  });
});

describe("removeLiquidity and collectFees", () => {
  const registry = createRegistry([rateManifest]);

  it.each(["removeLiquidity", "collectFees"] as const)("%s builds one call that pays the signer, and the manifest decodes it", async (name) => {
    const { client } = chain();
    const txs = await adapter.actions[name]!.build(adapter.actions[name]!.intent.parse({ tokenId: "7" }), ctx(client));
    expect(txs).toHaveLength(1);
    expect(txs[0]!.to).toBe(MANAGER);
    expect(registry.decode(txs[0]!, ALICE)).toMatchObject({ protocol: "rate", action: name, spends: false, spend: [], recipient: ALICE });
  });

  it("withdraws all of the position, with floors 1% under what it returns now, and a 10-minute deadline", async () => {
    const { client, simulateContract } = chain({ withdrawable: [1_000n, 2_000n] });
    const before = BigInt(Math.floor(Date.now() / 1000));
    const [remove] = await adapter.actions.removeLiquidity!.build({ tokenId: "7" }, ctx(client));
    const { functionName, args } = decodeFunctionData({ abi: BandPositionManagerABI, data: remove!.data });
    expect(functionName).toBe("decreaseLiquidity");
    const [tokenId, bps, minBase, minQuote, recipient, deadline] = args as unknown as [bigint, number, bigint, bigint, Address, bigint];
    expect([tokenId, bps, minBase, minQuote, recipient]).toEqual([7n, 10_000, 990n, 1_980n, ALICE]);
    expect(deadline - before).toBeGreaterThanOrEqual(600n);
    expect(deadline - before).toBeLessThanOrEqual(601n);
    // The floor came from simulating this exact withdrawal, as the signer, with no floor.
    expect(simulateContract).toHaveBeenCalledWith(expect.objectContaining({ account: ALICE, address: MANAGER, functionName: "decreaseLiquidity", args: [7n, 10_000, 0n, 0n, ALICE, deadline] }));
  });

  it("says so when the withdrawal cannot be simulated, instead of building one with no floor", async () => {
    const { client } = chain({ withdrawable: null });
    await expect(adapter.actions.removeLiquidity!.build({ tokenId: "7" }, ctx(client))).rejects.toThrow(/cannot be withdrawn right now/);
  });

  it("refuses a position the wallet does not hold, before anything is built", async () => {
    const { client } = chain({ holder: MALLORY });
    await expect(adapter.actions.removeLiquidity!.build({ tokenId: "7" }, ctx(client))).rejects.toThrow(/does not hold/);
  });

  it("withdrawing always asks: leaving early forfeits fees, and no rule should do that quietly. Collecting fees does not.", async () => {
    const { client } = chain();
    const remove = (await adapter.actions.removeLiquidity!.build({ tokenId: "7" }, ctx(client)))[0]!;
    const collect = (await adapter.actions.collectFees!.build({ tokenId: "7" }, ctx(client)))[0]!;
    expect(registry.decode(remove, ALICE)).toMatchObject({ action: "removeLiquidity", alwaysAsk: true });
    expect(registry.decode(collect, ALICE)?.alwaysAsk).toBeUndefined();
  });

  it("a withdrawal that pays someone else is not a known action: the wallet falls back to raw calldata and no rule can cover it", () => {
    const data = encodeFunctionData({ abi: BandPositionManagerABI, functionName: "decreaseLiquidity", args: [7n, 10_000, 0n, 0n, MALLORY, DEADLINE] });
    expect(registry.decode(tx(MANAGER, data), ALICE)).toBeNull();
    const collect = encodeFunctionData({ abi: BandPositionManagerABI, functionName: "collect", args: [7n, MALLORY] });
    expect(registry.decode(tx(MANAGER, collect), ALICE)).toBeNull();
  });
});

describe("reads", () => {
  it("bands: the pool the factory names, and each band's state in base units", async () => {
    const { client } = chain();
    expect(await adapter.reads.bands!.run({ base: EURC, quote: USDC }, ctx(client))).toEqual({
      pool: POOL, base: EURC, quote: USDC, baseDecimals: 6, quoteDecimals: 6, reachPct: "0.4",
      bands: [
        { band: 0, tolerancePct: "0.1", withinReach: true, open: true, empty: false, baseReserve: "1000000", quoteReserve: "2000000" },
        { band: 1, tolerancePct: "0.3", withinReach: true, open: true, empty: true, baseReserve: "0", quoteReserve: "0" },
        { band: 2, tolerancePct: "0.5", withinReach: true, open: false, empty: false, baseReserve: "5", quoteReserve: "5" },
      ],
    });
  });

  it("position: what withdrawing now returns, and the fees it would forfeit", async () => {
    const { client } = chain();
    expect(await adapter.reads.position!.run({ tokenId: "7" }, ctx(client))).toEqual({
      tokenId: "7", pool: POOL, base: EURC, quote: USDC, baseDecimals: 6, quoteDecimals: 6, bands: [{ band: 0, open: true }, { band: 1, open: false }], heldByWallet: true,
      // Vested: 2 owed + 2 vested-pending; forfeited: (3 - 2) + (1 - 0) pending that has not vested.
      principal: { base: "600", quote: "1200" }, feesVested: { base: "4", quote: "8" }, feesForfeitedIfRemovedNow: { base: "2", quote: "4" },
    });
  });
});

describe("isUnguardedRateWithdrawal: the manifest pins the recipient; floors and deadline are held here", () => {
  const now = () => BigInt(Math.floor(Date.now() / 1000));
  const withdraw = (minBase: bigint, minQuote: bigint, deadline: bigint) =>
    tx(MANAGER, encodeFunctionData({ abi: BandPositionManagerABI, functionName: "decreaseLiquidity", args: [1n, 10_000, minBase, minQuote, ALICE, deadline] }));

  it("passes what the builder makes: floors under the simulated return, ten minutes to land", () => {
    expect(isUnguardedRateWithdrawal(withdraw(990n, 1_980n, now() + 600n))).toBe(false);
    // One side may be empty: a position can hold a single token.
    expect(isUnguardedRateWithdrawal(withdraw(0n, 1_980n, now() + 600n))).toBe(false);
  });

  it.each([
    ["no floor on either side", () => withdraw(0n, 0n, now() + 600n)],
    ["a deadline already passed", () => withdraw(1n, 1n, now() - 1n)],
    ["a deadline more than an hour away", () => withdraw(1n, 1n, now() + 3_601n)],
  ])("flags %s", (_name, make) => {
    expect(isUnguardedRateWithdrawal(make())).toBe(true);
  });

  it("says nothing about other calls", () => {
    expect(isUnguardedRateWithdrawal(tx(MANAGER, encodeFunctionData({ abi: BandPositionManagerABI, functionName: "collect", args: [1n, ALICE] })))).toBe(false);
  });
});
