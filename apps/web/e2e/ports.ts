/**
 * Where the suite listens. `E2E_PORT` moves the whole set, so two checkouts can run their suites at once:
 * the app at the base port, and the two mock chains just below it.
 */
const base = Number(process.env.E2E_PORT ?? 3100);
if (!Number.isInteger(base) || base < 1024 || base > 65000) throw new Error(`E2E_PORT must be a port number; got ${process.env.E2E_PORT}`);

export const APP_PORT = base;
export const APP_ORIGIN = `http://localhost:${APP_PORT}`;
export const MOCK_CHAIN_PORT = base + 99;
export const RISE_MOCK_PORT = base + 98;
