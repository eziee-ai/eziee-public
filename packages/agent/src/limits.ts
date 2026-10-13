/** How many model calls one user message may cause, at most. What it may SPEND is bounded separately, by the budget. */
export const MAX_STEPS = 8;
/** The most one model call may write. Part of the hold's worst case. */
export const MAX_OUTPUT_TOKENS = 4_096;
