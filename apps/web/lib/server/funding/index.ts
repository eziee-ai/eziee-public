import { NextResponse } from "next/server";
import { clean } from "@repo/protocols/text";
import { problem } from "../http";
import { createAuroraIntents, FundingError } from "./aurora";

/** This deployment's funding route. Off (every network unsupported) without AURORA_INTENTS_API_KEY. */
export const fundingRoute = createAuroraIntents({ apiKey: process.env.AURORA_INTENTS_API_KEY || undefined });

/** A funding failure as an answer. `FundingError` messages are fixed sentences; anything else says nothing. */
export function fundingProblem(error: unknown): NextResponse {
  if (error instanceof FundingError) return problem(error.code === "UNAVAILABLE" ? 503 : error.code === "NOT_SUPPORTED" ? 404 : 400, `FUNDING_${error.code}`, error.message);
  console.error("[funding] unexpected failure");
  return problem(503, "FUNDING_UNAVAILABLE", "The funding service could not be reached.");
}

/** Text from the funding service that a person will read (a refund reason): data, cleaned like any other. */
export const cleanReason = (reason: string | undefined) => (reason ? clean(reason, 200) : undefined);
