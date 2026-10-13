import { describe, expect, it, afterEach } from "vitest";
import { prfKnownUnavailable } from "./webauthnClient";

/**
 * The preflight is deliberately asymmetric and that is the whole risk: it gates
 * whether a wallet can be created at all. Inverted, it refuses on every browser
 * that has not shipped `getClientCapabilities` yet — which is most of them.
 *
 * So each case here is "does an UNKNOWN answer still let the ceremony run".
 */
const g = globalThis as { PublicKeyCredential?: unknown };
const original = g.PublicKeyCredential;

afterEach(() => {
  if (original === undefined) delete g.PublicKeyCredential;
  else g.PublicKeyCredential = original;
});

describe("prfKnownUnavailable", () => {
  it("refuses ONLY on an explicit false", async () => {
    g.PublicKeyCredential = {
      getClientCapabilities: async () => ({ "extension:prf": false }),
    };
    expect(await prfKnownUnavailable()).toBe(true);
  });

  it("allows when the browser says PRF is available", async () => {
    g.PublicKeyCredential = {
      getClientCapabilities: async () => ({ "extension:prf": true }),
    };
    expect(await prfKnownUnavailable()).toBe(false);
  });

  it("allows when the key is absent — unknown is not a negative", async () => {
    g.PublicKeyCredential = {
      getClientCapabilities: async () => ({ conditionalGet: true }),
    };
    expect(await prfKnownUnavailable()).toBe(false);
  });

  it("allows when the API predates getClientCapabilities", async () => {
    g.PublicKeyCredential = {};
    expect(await prfKnownUnavailable()).toBe(false);
  });

  it("allows when there is no WebAuthn at all — mera's own error is clearer", async () => {
    delete g.PublicKeyCredential;
    expect(await prfKnownUnavailable()).toBe(false);
  });

  it("allows when the capability call throws, rather than propagating", async () => {
    g.PublicKeyCredential = {
      getClientCapabilities: async () => {
        throw new Error("not implemented");
      },
    };
    expect(await prfKnownUnavailable()).toBe(false);
  });

  it("treats undefined the same as absent", async () => {
    g.PublicKeyCredential = {
      getClientCapabilities: async () => ({ "extension:prf": undefined }),
    };
    expect(await prfKnownUnavailable()).toBe(false);
  });
});
