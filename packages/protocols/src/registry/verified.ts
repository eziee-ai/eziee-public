import type { Manifest } from "../manifest";

/**
 * Protocols that joined over MCP and passed review (guideline §3, tier "Verified").
 *
 * A protocol is added HERE, in a pull request, by importing its reviewed `registry/<id>/manifest.json` and parsing
 * it. That is the whole act of trusting it: this list is compiled into the app AND into the wallet frame, and the
 * frame decodes only what is in it. Nothing is ever added at run time, by a server, a setting or a fetch.
 *
 *   import raw from "../../registry/<id>/manifest.json";
 *   export const VERIFIED_MANIFESTS = [parseManifest(raw)];
 *
 * Its server's address and key are deployment configuration (`MCP_<ID>_URL`, `MCP_<ID>_KEY`). A manifest here
 * with no server configured is simply not offered.
 */
export const VERIFIED_MANIFESTS: readonly Manifest[] = [];
