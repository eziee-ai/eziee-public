import { beforeEach, describe, expect, it } from "vitest";
import {
  closeWalletConnect,
  readConnectRequest,
  requestWalletConnect,
  subscribeConnectRequest,
} from "./connectGate";

describe("connect gate store", () => {
  beforeEach(() => closeWalletConnect());

  it("starts closed", () => {
    expect(readConnectRequest().open).toBe(false);
  });

  it("carries the caller's reason, so the dialog can say why it appeared", () => {
    requestWalletConnect("Connect a wallet to keep a watchlist.");
    const request = readConnectRequest();
    expect(request.open).toBe(true);
    expect(request.reason).toBe("Connect a wallet to keep a watchlist.");
  });

  it("a request with no reason still opens", () => {
    requestWalletConnect();
    expect(readConnectRequest().open).toBe(true);
    expect(readConnectRequest().reason).toBeUndefined();
  });

  it("notifies subscribers on open and on close", () => {
    let notifications = 0;
    const unsubscribe = subscribeConnectRequest(() => {
      notifications += 1;
    });
    requestWalletConnect("why");
    closeWalletConnect();
    expect(notifications).toBe(2);
    unsubscribe();
  });

  it("closing an already-closed store notifies NOBODY", () => {
    // The early return is load-bearing: `useSyncExternalStore` re-renders every
    // subscriber on each notification, and `ConnectWalletDialog` is mounted for
    // the whole app. Emitting on a no-op close would re-render it on any stray
    // call, and a caller closing in an effect would loop.
    const unsubscribe = subscribeConnectRequest(() => {
      throw new Error("must not notify on a no-op close");
    });
    expect(() => closeWalletConnect()).not.toThrow();
    unsubscribe();
  });

  it("holds ONE request, so two gated clicks cannot stack two dialogs", () => {
    requestWalletConnect("first");
    requestWalletConnect("second");
    expect(readConnectRequest().reason).toBe("second");
    // One close returns it to closed — there is no queue to drain.
    closeWalletConnect();
    expect(readConnectRequest().open).toBe(false);
  });

  it("the snapshot is referentially stable while closed", () => {
    // A fresh object per read makes useSyncExternalStore loop forever.
    expect(readConnectRequest()).toBe(readConnectRequest());
  });

  it("unsubscribing actually stops notifications", () => {
    let notifications = 0;
    const unsubscribe = subscribeConnectRequest(() => {
      notifications += 1;
    });
    unsubscribe();
    requestWalletConnect("after unsubscribe");
    expect(notifications).toBe(0);
  });
});
