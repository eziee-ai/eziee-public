"use client";

/**
 * The app's handle on the wallet frame.
 *
 * One hidden iframe, created on first use and kept for the life of the page,
 * pointed at `<walletOrigin>/wallet-frame`. Every call here becomes one
 * `postMessage` request and resolves on the matching response. Nothing here
 * ever sees a key: `unlock` sends PRF bytes IN and the caller zeroes them,
 * `request` gets a signature or a hash OUT.
 *
 * ## Imperative, not a component
 *
 * The connector needs the frame before React has mounted anything —
 * `reconnect` runs in the first effect — so the iframe is appended to
 * `document.body` by this module rather than rendered by a component that
 * might or might not be in the tree yet. A single instance is the point; two
 * frames would be two views of the same storage racing each other.
 *
 * ## Readiness has a timeout; requests do not
 *
 * The frame announces `ready` when its script runs. If that never arrives —
 * the wallet origin is down, misconfigured, blocked by an extension — the
 * caller gets an error naming the frame within `READY_TIMEOUT_MS`, rather
 * than a connect button that spins forever. A signature request, once the
 * frame is up, waits as long as the chain does; a broadcast can legitimately
 * take a while and a timer that gave up would orphan a transaction the frame
 * has already sent.
 *
 * ## Only the frame's own window is believed
 *
 * `event.source === iframe.contentWindow && event.origin === walletOrigin()`.
 * A response that fails either test is dropped. The id is a random UUID, so
 * a sender that passed both checks still could not resolve a request it did
 * not see.
 */

import { FRAME_PATH, isIsolated, walletOrigin } from "./origins";
import {
  isEventEnvelope,
  isResponseEnvelope,
  request as makeRequest,
  WalletFrameError,
  type RequestParams,
  type StatusResult,
  type WalletRpc,
} from "./protocol";
import type { Address, Hex } from "viem";
import { walletConfig } from "../config";

const READY_TIMEOUT_MS = 10_000;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

export interface WalletFrame {
  status(): Promise<StatusResult>;
  resume(): Promise<Address>;
  unlock(prfOutput: Uint8Array): Promise<Address>;
  request(chainId: number, rpc: WalletRpc): Promise<Hex>;
  disconnect(): Promise<void>;
}

class WalletFrameClient implements WalletFrame {
  private frame: HTMLIFrameElement | null = null;
  private ready: Promise<Window> | null = null;
  private readonly pending = new Map<string, Pending>();
  private warned = false;

  private ensure(): Promise<Window> {
    if (this.ready) return this.ready;
    if (typeof document === "undefined") {
      return Promise.reject(new Error("The wallet frame needs a document."));
    }

    const origin = walletOrigin();
    if (!isIsolated() && process.env.NODE_ENV === "production" && !this.warned) {
      this.warned = true;
      // Loud on purpose. Same-origin is the local-development shape; a
      // production build in it has shipped without the boundary this whole
      // module exists for. See lib/wallet/frame/origins.ts.
      console.error(
        "[wallet] NEXT_PUBLIC_WALLET_ORIGIN is unset: the wallet frame is same-origin and its storage is readable by this page.",
      );
    }

    this.ready = new Promise<Window>((resolve, reject) => {
      const frame = document.createElement("iframe");
      frame.setAttribute("aria-hidden", "true");
      frame.setAttribute("tabindex", "-1");
      frame.title = `${walletConfig().brand} wallet`;
      // Hidden by size, not `display:none`: some browsers throttle or defer
      // script in a display-none frame, and this one has to answer promptly.
      frame.style.cssText = "position:fixed;width:0;height:0;border:0;opacity:0;pointer-events:none;";
      this.frame = frame;

      let settled = false;
      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        this.ready = null;
        frame.remove();
        this.frame = null;
        reject(new Error(`The wallet frame at ${origin} did not answer.`));
      }, READY_TIMEOUT_MS);

      window.addEventListener("message", (e: MessageEvent) => {
        if (e.origin !== origin || !this.frame || e.source !== this.frame.contentWindow) return;

        if (isEventEnvelope(e.data)) {
          if (e.data.data.event === "ready" && !settled) {
            settled = true;
            window.clearTimeout(timer);
            resolve(this.frame.contentWindow as Window);
          }
          return;
        }

        if (isResponseEnvelope(e.data)) {
          const waiting = this.pending.get(e.data.id);
          if (!waiting) return;
          this.pending.delete(e.data.id);
          if (e.data.error) waiting.reject(new WalletFrameError(e.data.error));
          else waiting.resolve(e.data.result);
        }
      });

      // Listener first, then src: a frame that boots faster than the listener
      // attaches would announce readiness to nobody.
      frame.src = `${origin}${FRAME_PATH}`;
      document.body.appendChild(frame);
    });

    return this.ready;
  }

  private async call<T>(method: "status" | "resume" | "unlock" | "request" | "disconnect", params?: unknown): Promise<T> {
    const target = await this.ensure();
    const id = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      target.postMessage(makeRequest(id, method, params), walletOrigin());
    });
  }

  status(): Promise<StatusResult> {
    return this.call<StatusResult>("status");
  }

  async resume(): Promise<Address> {
    const { address } = await this.call<{ address: Address }>("resume");
    return address;
  }

  async unlock(prfOutput: Uint8Array): Promise<Address> {
    // The bytes cross by structured clone — a COPY. The caller zeroes its
    // original; the frame zeroes the copy once it has derived and wrapped it.
    const { address } = await this.call<{ address: Address }>("unlock", { prfOutput });
    return address;
  }

  request(chainId: number, rpc: WalletRpc): Promise<Hex> {
    const params: RequestParams = { chainId, rpc };
    return this.call<Hex>("request", params);
  }

  async disconnect(): Promise<void> {
    await this.call("disconnect");
  }
}

/** The one frame. */
export const walletFrame: WalletFrame = new WalletFrameClient();
