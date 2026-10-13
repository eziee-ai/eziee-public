/** Machine-readable failure codes. The agent layer hands `code` to the model; `message` is for humans. */
export type ProtocolErrorCode =
  | "INVALID_MANIFEST"
  | "INVALID_INTENT"
  | "UNKNOWN_TOKEN"
  | "UNSUPPORTED_CHAIN"
  | "QUOTE_MOVED"
  | "INSUFFICIENT_LIQUIDITY"
  | "AMOUNT_TOO_SMALL"
  | "TEMPORARILY_UNAVAILABLE";

export class ProtocolError extends Error {
  readonly code: ProtocolErrorCode;

  constructor(code: ProtocolErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProtocolError";
    this.code = code;
  }
}
