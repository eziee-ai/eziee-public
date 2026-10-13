import { describe, expect, it, vi } from "vitest";
import { preflightFunding, sendFunding, type DiscoveredWallet } from "./externalFunding";

const ME = "0x1111111111111111111111111111111111111111" as const;
const TO = "0x2222222222222222222222222222222222222222" as const;
const ARC = 5042002;
const ARC_HEX = `0x${ARC.toString(16)}`;

/** A wallet that records every RPC method it is asked for, in order. */
function stub(
  opts: { accounts?: string[]; chainId?: string; balance?: string; gasPrice?: string | null } = {},
) {
  const methods: string[] = [];
  const wallet: DiscoveredWallet = {
    rdns: "test.wallet",
    name: "Test",
    icon: "",
    provider: {
      request: vi.fn(async ({ method }: { method: string }) => {
        methods.push(method);
        if (method === "eth_accounts") return opts.accounts ?? [ME];
        if (method === "eth_chainId") return opts.chainId ?? ARC_HEX;
        if (method === "eth_getBalance") return opts.balance ?? "0x0";
        // Feeds the Max button's gas reserve. Silent, like the three above.
        if (method === "eth_gasPrice") {
          if (opts.gasPrice === null) throw new Error("no gas price");
          return opts.gasPrice ?? "0x3b9aca00";
        }
        // Everything past the reads is out of scope: these tests are about
        // WHICH requests are made and when, not about signing.
        throw new Error("stop");
      }),
    } as never,
  };
  return { wallet, methods };
}

describe("preflightFunding", () => {
  it("reads the account, the chain and the balance, and prompts for none of them", async () => {
    // All three are silent methods. If any of these became a prompting call it
    // would fire while the user was still typing an amount.
    const { wallet, methods } = stub({ balance: "0x2386f26fc10000" });
    const result = await preflightFunding({ chainId: ARC, amount: "0.05", wallet });

    expect(result?.account).toBe(ME);
    expect(result?.onChain).toBe(true);
    expect(methods).toEqual([
      "eth_accounts",
      "eth_chainId",
      "eth_getBalance",
      // Added for the Max button's gas reserve: on Arc the asset being
      // deposited is also what pays for the deposit, so Max has to hold some
      // back. Silent, like the three above — which is what this list guards.
      "eth_gasPrice",
    ]);
    expect(methods).not.toContain("eth_requestAccounts");
    expect(methods).not.toContain("wallet_switchEthereumChain");
  });

  it("still answers when the gas price cannot be read", async () => {
    /*
     * "We could not ask" is not "gas is free". The preflight keeps working and
     * reports a null price; `gasReserve` then holds nothing back rather than
     * inventing a number, so Max falls back to the plain balance and the wallet
     * remains the thing that refuses an unaffordable send.
     */
    const { wallet } = stub({ gasPrice: null });
    const result = await preflightFunding({ chainId: ARC, amount: "0.05", wallet });
    expect(result?.account).toBe(ME);
    expect(result?.gasPrice).toBeNull();
  });

  it("answers null when the site is not connected, instead of prompting", async () => {
    // The connect step is a separate, deliberate action. Probing further here
    // would open a dialog nobody asked for.
    const { wallet, methods } = stub({ accounts: [] });
    expect(await preflightFunding({ chainId: ARC, amount: "0.05", wallet })).toBeNull();
    expect(methods).not.toContain("eth_requestAccounts");
  });

  it("reports a wallet standing on the wrong chain without moving it", async () => {
    const { wallet, methods } = stub({ chainId: "0x1" });
    const result = await preflightFunding({ chainId: ARC, amount: "0.05", wallet });

    expect(result?.onChain).toBe(false);
    // Switching is the CLICK's job: a switch prompt is a dialog, and firing one
    // while the user types would interrupt them.
    expect(methods).not.toContain("wallet_switchEthereumChain");
  });
});

describe("sendFunding", () => {
  it("issues NO reads before the wallet request when already on the chain", async () => {
    // The property this whole split exists for. A browser wallet opens its
    // popup on the strength of the click that led to it; RPC round trips in
    // between lose the gesture, and MetaMask then queues the transaction behind
    // a toolbar badge with nothing on the page to say so.
    const { wallet, methods } = stub();
    await sendFunding({
      to: TO, chainId: ARC, amount: "0.05", account: ME, wallet, needsSwitch: false,
    }).catch(() => undefined);

    expect(methods).not.toContain("eth_accounts");
    expect(methods).not.toContain("eth_chainId");
    expect(methods).not.toContain("eth_getBalance");
  });

  it("switches first only when the preflight said it must", async () => {
    // A switch is a dialog the user sees, so spending the gesture on it is
    // honest — but only when it is actually needed.
    const { wallet, methods } = stub({ chainId: "0x1" });
    await sendFunding({
      to: TO, chainId: ARC, amount: "0.05", account: ME, wallet, needsSwitch: true,
    }).catch(() => undefined);

    expect(methods).toContain("wallet_switchEthereumChain");
  });

  it("reports the step it is on, so a queued prompt can be named", async () => {
    const steps: string[] = [];
    const { wallet } = stub();
    await sendFunding({
      to: TO, chainId: ARC, amount: "0.05", account: ME, wallet, needsSwitch: false,
      onStep: (step) => steps.push(step),
    }).catch(() => undefined);

    expect(steps).toContain("send");
  });
});
