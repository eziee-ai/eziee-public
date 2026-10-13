import type { WebAuthnClient } from "@category-labs/mera";

/**
 * mera's browser WebAuthn client, with three changes it does not make itself.
 *
 * mera keeps its ceremony minimal and does not export its default client, so
 * steering the ceremony means supplying one. This mirrors that client field for
 * field — same challenge, same transports, same assertion path — and changes
 * only what is below. Key derivation is untouched and stays mera's: this file
 * decides WHICH authenticator answers and HOW it is asked, never what is done
 * with its output.
 *
 * ## 0. `prf: {}` at creation instead of `prf: { eval }` — the actual bug
 *
 * See the comment at the extension itself. This is the one that turns
 * `PRF_UNAVAILABLE` into a working wallet on Chrome; the two below are why the
 * user reaches a usable authenticator at all.
 *
 * ## 1. `hints`, so the browser offers a choice
 *
 * With no hint, Chrome on macOS sends `create()` straight to the system
 * provider — iCloud Keychain — and a Mac with it switched off gets the OS
 * demanding it be turned on before any picker appears. That is the dialog users
 * see instead of being asked where to save.
 *
 * `hints` is WebAuthn Level 3 and Chrome honours it. Listing all three in
 * preference order makes the picker itself the first thing shown, which is what
 * a user expects — and here it is load-bearing, because PRF is the entire basis
 * of this wallet (mera treats its output as the secp256k1 private key) and not
 * every authenticator implements it. When the one the browser reaches for does
 * not, the only paths that work are the ones a picker reaches: another provider,
 * a phone over hybrid, or a security key.
 *
 * The order is deliberate and is documented at HINTS — leading with
 * `client-device` is what sent Chrome straight into the built-in authenticator
 * instead of offering a choice.
 *
 * ## 2. A capability preflight, so a dead passkey is not created
 *
 * mera can only check PRF AFTER `navigator.credentials.create()` has succeeded,
 * because that is when the authenticator reports it. So a provider without PRF
 * leaves a credential behind that this app can never use, and every retry
 * leaves another — a list of identical "eziee wallet" entries with no way to
 * delete them from script, since WebAuthn has no delete API.
 *
 * `PublicKeyCredential.getClientCapabilities()` reports `extension:prf` and is
 * the standard way to ask in advance. It is recent, so its ABSENCE proves
 * nothing and must not block: unknown means proceed and let mera's own check
 * decide. Only an explicit `false` refuses.
 */

/** WebAuthn L3, and newer than the DOM lib here — see the file header. */
type PublicKeyCredentialWithCapabilities = {
  getClientCapabilities?: () => Promise<Record<string, boolean | undefined>>;
};

/**
 * Does this browser say PRF is unavailable?
 *
 * Deliberately asymmetric, and the asymmetry is the point. `true` is returned
 * ONLY on an explicit negative. A browser too old for `getClientCapabilities`,
 * a thrown call, a missing key — all answer "not known to be unavailable", so
 * the ceremony still runs. Guessing the other way would refuse to create a
 * wallet on every browser that has not shipped the API yet.
 */
export async function prfKnownUnavailable(): Promise<boolean> {
  try {
    const pkc = (globalThis as { PublicKeyCredential?: PublicKeyCredentialWithCapabilities })
      .PublicKeyCredential;
    if (typeof pkc?.getClientCapabilities !== "function") return false;
    const caps = await pkc.getClientCapabilities();
    return caps["extension:prf"] === false;
  } catch {
    return false;
  }
}

/**
 * Preference order for where the passkey lives — and the order is the point.
 *
 * `hints` is ORDERED: Chrome takes the first entry as what the site prefers and
 * opens that flow. So `client-device` first does not mean "offer the built-in
 * one among others", it means "go straight to the built-in one" — which on
 * macOS is iCloud Keychain, and is what kept producing the "enable iCloud
 * Keychain" dialog instead of a choice.
 *
 * `client-device` leads because the providers that carry PRF on desktop are
 * PLATFORM authenticators — a Google Password Manager passkey reports
 * `transports: ["internal"]` just like an iCloud Keychain one. Leading with
 * `hybrid` steers into the phone flow, which is not a desktop answer.
 *
 * ## Desktop Chrome has three platform stores and only two carry PRF
 *
 * Per mera's own authenticator-support notes:
 * https://mera.category.xyz/authenticator-support/#the-desktop-chrome-complication
 *
 * Only passkeys saved to GOOGLE PASSWORD MANAGER carry PRF on desktop Chrome.
 * The LOCAL CHROME PROFILE authenticator has no `hmac-secret` and cannot.
 * iCloud Keychain does carry it, on macOS 15+.
 *
 * Chrome writes to the local profile instead of GPM when "Offer to save
 * passwords and passkeys" is off, when the profile is signed out, or when a
 * third-party password-manager extension intercepts WebAuthn. The credential is
 * created either way and simply returns no PRF — `{"prf":{"enabled":false}}`,
 * which at this layer is indistinguishable from an authenticator that has none.
 *
 * That is the real cause, and it is a SETTING rather than a limit: no hint
 * chooses between platform providers, so the throw below names the three
 * settings instead of pretending the ceremony can fix it.
 *
 * The picker itself is CHROME's UI, not something this app renders. All the app
 * can do is say what it prefers; what the browser shows, and in what order, is
 * the browser's decision.
 */
const HINTS = ["client-device", "hybrid", "security-key"] as const;

function assertPublicKeyCredential(credential: Credential | null): PublicKeyCredential {
  if (!credential || !("rawId" in credential)) {
    throw new Error("The authenticator returned no credential.");
  }
  return credential as PublicKeyCredential;
}

export const hintedWebAuthnClient: WebAuthnClient = {
  async createCredential(request) {
    const credential = await globalThis.navigator?.credentials?.create({
      publicKey: {
        rp: request.rp,
        user: request.user,
        challenge: request.challenge,
        pubKeyCredParams: request.algorithms.map((alg) => ({
          type: "public-key" as const,
          alg,
        })),
        ...(request.timeout !== undefined ? { timeout: request.timeout } : {}),
        attestation: request.attestation,
        authenticatorSelection: {
          residentKey: request.residentKey,
          // WebAuthn Level 1's boolean, kept in step with residentKey for
          // authenticators that still read it. Note there is deliberately NO
          // `authenticatorAttachment`: pinning it to "platform" is what would
          // make the picker unreachable, which is the bug being fixed.
          requireResidentKey: true,
          userVerification: request.userVerification,
        },
        // The only real addition. Cast because `hints` is Level 3 and newer
        // than the DOM lib this project compiles against; an unknown key here
        // is ignored by browsers that do not implement it.
        hints: HINTS,
        // `prf: {}` — ENABLE only, no `eval`. This is the difference between a
        // wallet and `PRF_UNAVAILABLE` on Chrome.
        //
        // Evaluating PRF during creation is OPTIONAL in the spec, and Chrome
        // does not do it: asked for `prf: { eval: ... }` it returns no `prf` in
        // the extension results at all, so `enabled` reads false and mera
        // concludes the authenticator has no PRF. Measured on this machine,
        // Chrome reports `extension:prf: true` and `extension:hmacCreateSecret:
        // true` from `getClientCapabilities()` — PRF is fully supported, it just
        // cannot be evaluated in the same ceremony that creates the credential.
        //
        // Asking to ENABLE it is the interop-safe form: Chrome answers
        // `{ enabled: true }`, and mera's own fallback then fetches the output
        // with a follow-up assertion, which is the path the spec intends.
        // `eval` here, not a bare `prf: {}`. Both ENABLE prf; the difference is
        // whether the output can come back in this same ceremony. A store that
        // evaluates at creation answers with `results.first` and the user taps
        // ONCE; `prf: {}` cannot ever return output, so mera's assertion
        // fallback always runs and the user is prompted TWICE. Asking for eval
        // is therefore strictly better: best case one prompt, worst case the
        // same two.
        //
        // (Asking for eval was never what broke this — the local Chrome profile
        // store returning no PRF was. See the header.)
        extensions: { prf: { eval: { first: request.prfSalt } } },
      } as PublicKeyCredentialCreationOptions,
    });

    const publicKeyCredential = assertPublicKeyCredential(credential);
    const extensionResults = publicKeyCredential.getClientExtensionResults();
    const prf = extensionResults.prf;
    const response = publicKeyCredential.response as AuthenticatorAttestationResponse;
    const transports =
      typeof response.getTransports === "function" ? response.getTransports() : undefined;
    const first = prf?.results?.first;

    console.debug("[wallet] passkey extension results", extensionResults, { transports });

    // Fail HERE, naming the authenticator, rather than letting mera raise its
    // generic "Authenticator did not enable PRF" two frames up.
    //
    // The distinction that cost several rounds of this: capabilities are the
    // BROWSER's, transports are the AUTHENTICATOR's.
    // `getClientCapabilities()` reporting `extension:prf: true` says Chrome
    // implements PRF — it says nothing about the key that just answered.
    // `transports: ["internal"]` is the built-in one, `hybrid` is a phone and
    // `usb`/`nfc` a security key.
    //
    // So the message names what answered and what to pick instead, because the
    // fix is a different authenticator and no amount of ceremony tuning
    // substitutes for one.
    if (prf?.enabled !== true) {
      const where = transports?.length ? transports.join(", ") : "unknown";
      const builtIn = !transports || transports.includes("internal");
      throw new Error(
        `That passkey does not carry PRF (transports: ${where}), which is what derives the wallet key. ` +
          (builtIn
            ? "On desktop Chrome that means it was saved to the LOCAL CHROME PROFILE, whose authenticator has " +
              "no hmac-secret — only Google Password Manager passkeys carry PRF there. Fix: sign in to Chrome, " +
              "turn ON \u201cOffer to save passwords and passkeys\u201d in chrome://settings/passwords, and disable any " +
              "password-manager extension that intercepts WebAuthn. Any of those three makes Chrome write to the " +
              "local profile instead. iCloud Keychain also carries PRF on macOS 15+."
            : "Try a different passkey provider.") +
          ` (extension results: ${JSON.stringify(extensionResults)})`,
      );
    }

    return {
      credentialId: new Uint8Array(publicKeyCredential.rawId),
      ...(transports !== undefined ? { transports } : {}),
      prfEnabled: true,
      ...(first ? { prfOutput: new Uint8Array(first as ArrayBuffer) } : {}),
    };
  },

  async getCredential(request) {
    const { allowCredential } = request;
    const credential = await globalThis.navigator?.credentials?.get({
      publicKey: {
        rpId: request.rpId,
        challenge: request.challenge,
        ...(request.timeout !== undefined ? { timeout: request.timeout } : {}),
        userVerification: request.userVerification,
        extensions: { prf: { eval: { first: request.prfSalt } } },
        ...(allowCredential !== undefined
          ? {
              allowCredentials: [
                {
                  id: allowCredential.credentialId,
                  type: "public-key" as const,
                  ...(allowCredential.transports !== undefined
                    ? { transports: allowCredential.transports as AuthenticatorTransport[] }
                    : {}),
                },
              ],
            }
          : {}),
      },
    });

    const publicKeyCredential = assertPublicKeyCredential(credential);
    const first = publicKeyCredential.getClientExtensionResults().prf?.results?.first;
    if (!first) {
      // The unlock path has no second chance: `createPasskeyWithPrfOutput` can
      // fall back to an assertion, but an assertion that returns no PRF is the
      // end of the line.
      throw new Error("That passkey returned no PRF output — it cannot unlock this wallet.");
    }
    return {
      credentialId: new Uint8Array(publicKeyCredential.rawId),
      prfOutput: new Uint8Array(first as ArrayBuffer),
    };
  },
};
