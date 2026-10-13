import { parseManifest, type Manifest } from "../manifest/schema";
import raw from "../../registry/rate/manifest.json";

/** Rate's manifest, validated at import so a bad vendoring run fails loudly, not at first use. */
export const rateManifest: Manifest = parseManifest(raw);
