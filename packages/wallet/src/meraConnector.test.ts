// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address, Hex } from "viem";
import { ERR, WalletFrameError, type StatusResult, type WalletRpc } from "./frame/protocol";
import type { WalletFrame } from "./frame/client";
import { configureTestWallet, TEST_CHAIN_A, TEST_CHAIN_B } from "./testing/fixture";

/**
 * The connector against a fake frame.
 *
 * What is pinned is the division of labour: the connector never derives an
 * address, never keeps a key, and never signs. Every one of those is a call
 * to the frame, and the PRF bytes it forwards are zeroed the moment the frame
 * has answered. The ceremony itself is mocked — a real one needs an
 * authenticator, which is the limit `webauthnClient.test.ts` records.
 */

const ADDRESS = "0x7a3F000000000000000000000000000000009C21" as Address;

const ceremony = vi.hoisted(() => ({
  hasCredential: false,
  unlock: vi.fn<() => Promise<Uint8Array | null>>(),
  create: vi.fn<() => Promise<Uint8Array>>(),
}));

vi.mock("./mera", () => ({
  hasMeraCredential: () => ceremony.hasCredential,
  unlockPasskeyKey: ceremony.unlock,
  createPasskeyKey: ceremony.create,
}));

vi.mock("./frame/origins", () => ({
  isIsolated: () => false,
  walletOrigin: () => "http://localhost",
  appOrigin: () => "http://localhost",
  FRAME_PATH: "/wallet-frame",
  CONFIRM_PATH: "/wallet-frame/confirm",
}));

function fakeFrame(initial: { session: Address | null }): WalletFrame & {
  calls: string[];
  unlockedWith: Uint8Array[];
  session: Address | null;
} {
  const frame = {
    calls: [] as string[],
    unlockedWith: [] as Uint8Array[],
    session: initial.session,
    async status(): Promise<StatusResult> {
      frame.calls.push("status");
      return { address: frame.session, expiresAt: frame.session ? Date.now() + 1000 : null };
    },
    async resume(): Promise<Address> {
      frame.calls.push("resume");
      if (!frame.session) throw new WalletFrameError({ code: ERR.LOCKED, message: "locked" });
      return frame.session;
    },
    async unlock(prfOutput: Uint8Array): Promise<Address> {
      frame.calls.push("unlock");
      // A COPY, as structured clone would make: the caller's zeroing must not
      // reach the frame's bytes, and the frame's must not reach the caller's.
      frame.unlockedWith.push(new Uint8Array(prfOutput));
      frame.session = ADDRESS;
      return ADDRESS;
    },
    async request(_chainId: number, rpc: WalletRpc): Promise<Hex> {
      frame.calls.push(`request:${rpc.method}`);
      return "0xhash";
    },
    async disconnect(): Promise<void> {
      frame.calls.push("disconnect");
      frame.session = null;
    },
  };
  return frame;
}

async function make(frame: WalletFrame) {
  const { meraConnector } = await import("./meraConnector");
  const emitter = { emit: vi.fn() };
  const factory = meraConnector({ userName: () => "eziee wallet", frame });
  return factory({ chains: [], emitter } as never);
}

beforeEach(() => {
  configureTestWallet();
  ceremony.hasCredential = false;
  ceremony.unlock.mockReset();
  ceremony.create.mockReset();
});

describe("reconnect", () => {
  it("resumes through the frame and never runs a ceremony", async () => {
    const frame = fakeFrame({ session: ADDRESS });
    const connector = await make(frame);
    const result = await connector.connect({ isReconnecting: true });
    expect(result.accounts).toEqual([ADDRESS]);
    expect(frame.calls).toEqual(["resume"]);
    expect(ceremony.unlock).not.toHaveBeenCalled();
    expect(ceremony.create).not.toHaveBeenCalled();
  });

  it("throws, without prompting, when there is nothing to resume", async () => {
    const frame = fakeFrame({ session: null });
    const connector = await make(frame);
    await expect(connector.connect({ isReconnecting: true })).rejects.toThrow(/expired/);
    expect(ceremony.unlock).not.toHaveBeenCalled();
    expect(await connector.getAccounts()).toEqual([]);
  });
});

describe("connect from a click", () => {
  it("resumes a live session without a ceremony", async () => {
    const frame = fakeFrame({ session: ADDRESS });
    const connector = await make(frame);
    await connector.connect();
    expect(frame.calls).toEqual(["resume"]);
    expect(ceremony.unlock).not.toHaveBeenCalled();
  });

  it("unlocks with the stored passkey, hands the PRF bytes to the frame, and zeroes them", async () => {
    ceremony.hasCredential = true;
    const prf = new Uint8Array(32).fill(7);
    ceremony.unlock.mockResolvedValue(prf);

    const frame = fakeFrame({ session: null });
    const connector = await make(frame);
    const result = await connector.connect();

    expect(result.accounts).toEqual([ADDRESS]);
    expect(frame.calls).toEqual(["resume", "unlock"]);
    expect(frame.unlockedWith[0]).toEqual(new Uint8Array(32).fill(7));
    // The connector's own copy is gone the moment the frame has answered.
    expect(Array.from(prf)).toEqual(new Array(32).fill(0));
    expect(ceremony.create).not.toHaveBeenCalled();
  });

  it("creates a passkey when none is stored", async () => {
    ceremony.create.mockResolvedValue(new Uint8Array(32).fill(1));
    const frame = fakeFrame({ session: null });
    const connector = await make(frame);
    await connector.connect();
    expect(ceremony.create).toHaveBeenCalledOnce();
    expect(frame.calls).toEqual(["resume", "unlock"]);
  });

  it("fails loudly when the stored passkey no longer resolves, rather than minting a second account", async () => {
    ceremony.hasCredential = true;
    ceremony.unlock.mockResolvedValue(null);
    const frame = fakeFrame({ session: null });
    const connector = await make(frame);
    await expect(connector.connect()).rejects.toThrow(/no longer available/);
    expect(ceremony.create).not.toHaveBeenCalled();
    expect(frame.calls).toEqual(["resume"]);
  });

  it("surfaces a frame failure that is not LOCKED", async () => {
    const frame = fakeFrame({ session: null });
    frame.resume = async () => {
      throw new Error("The wallet frame at http://localhost did not answer.");
    };
    const connector = await make(frame);
    await expect(connector.connect()).rejects.toThrow(/did not answer/);
    expect(ceremony.create).not.toHaveBeenCalled();
  });
});

describe("the provider", () => {
  it("answers identity locally and sends signing methods to the frame", async () => {
    const frame = fakeFrame({ session: ADDRESS });
    const connector = await make(frame);
    await connector.connect({ isReconnecting: true, chainId: TEST_CHAIN_B.id });
    const provider = await connector.getProvider();

    expect(await provider.request({ method: "eth_accounts" })).toEqual([ADDRESS]);
    expect(await provider.request({ method: "eth_chainId" })).toBe(`0x${TEST_CHAIN_B.id.toString(16)}`);
    expect(await provider.request({ method: "personal_sign", params: ["0x68", ADDRESS] } as never)).toBe("0xhash");
    expect(await provider.request({ method: "eth_sendTransaction", params: [{}] } as never)).toBe("0xhash");
    expect(frame.calls.filter((c) => c.startsWith("request:"))).toEqual([
      "request:personal_sign",
      "request:eth_sendTransaction",
    ]);
  });

  it("exists before connect, and refuses every request while locked", async () => {
    // wagmi's reconnect() asks for the provider BEFORE isAuthorized() and skips a
    // connector whose getProvider() rejects, so a locked wallet must still hand one over.
    const frame = fakeFrame({ session: null });
    const connector = await make(frame);
    const provider = await connector.getProvider();
    await expect(provider.request({ method: "eth_accounts" })).rejects.toThrow(/locked/i);
    await expect(provider.request({ method: "personal_sign", params: ["0x68", ADDRESS] } as never)).rejects.toThrow(/locked/i);
    expect(frame.calls).toEqual([]);
  });

  it("is locked again after disconnect", async () => {
    const frame = fakeFrame({ session: ADDRESS });
    const connector = await make(frame);
    await connector.connect({ isReconnecting: true });
    const provider = await connector.getProvider();
    await connector.disconnect();
    await expect(provider.request({ method: "eth_accounts" })).rejects.toThrow(/locked/i);
  });
});

describe("wagmi's reconnect action", () => {
  it("resumes a stored session on page load, without a ceremony", async () => {
    const { createConfig, http } = await import("wagmi");
    const { reconnect } = await import("wagmi/actions");
    const { meraConnector } = await import("./meraConnector");
    const frame = fakeFrame({ session: ADDRESS });
    const config = createConfig({
      chains: [TEST_CHAIN_A, TEST_CHAIN_B],
      connectors: [meraConnector({ userName: () => "Test wallet", frame })],
      transports: { [TEST_CHAIN_A.id]: http(), [TEST_CHAIN_B.id]: http() },
      storage: null,
    });

    const connections = await reconnect(config);

    expect(connections.map((c) => c.accounts)).toEqual([[ADDRESS]]);
    expect(config.state.status).toBe("connected");
    expect(frame.calls).toEqual(["status", "resume"]);
    expect(ceremony.unlock).not.toHaveBeenCalled();
    expect(ceremony.create).not.toHaveBeenCalled();
  });

  it("stays disconnected, without prompting, when there is no session", async () => {
    const { createConfig, http } = await import("wagmi");
    const { reconnect } = await import("wagmi/actions");
    const { meraConnector } = await import("./meraConnector");
    const frame = fakeFrame({ session: null });
    const config = createConfig({
      chains: [TEST_CHAIN_A, TEST_CHAIN_B],
      connectors: [meraConnector({ userName: () => "Test wallet", frame })],
      transports: { [TEST_CHAIN_A.id]: http(), [TEST_CHAIN_B.id]: http() },
      storage: null,
    });

    expect(await reconnect(config)).toEqual([]);
    expect(config.state.status).toBe("disconnected");
    expect(frame.calls).toEqual(["status"]);
    expect(ceremony.unlock).not.toHaveBeenCalled();
  });
});

describe("isAuthorized", () => {
  it("is the frame's status", async () => {
    expect(await (await make(fakeFrame({ session: ADDRESS }))).isAuthorized()).toBe(true);
    expect(await (await make(fakeFrame({ session: null }))).isAuthorized()).toBe(false);
  });

  it("is false when the frame cannot be reached", async () => {
    const frame = fakeFrame({ session: ADDRESS });
    frame.status = async () => {
      throw new Error("did not answer");
    };
    expect(await (await make(frame)).isAuthorized()).toBe(false);
  });
});

describe("disconnect", () => {
  it("drops the address and tells the frame", async () => {
    const frame = fakeFrame({ session: ADDRESS });
    const connector = await make(frame);
    await connector.connect({ isReconnecting: true });
    await connector.disconnect();
    expect(await connector.getAccounts()).toEqual([]);
    expect(frame.calls).toContain("disconnect");
    expect(frame.session).toBeNull();
  });
});
