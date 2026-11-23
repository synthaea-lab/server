/**
 * Runs once when the server starts (Next `instrumentationHook`). Next compiles this file for
 * the Node and the Edge runtime alike, and the Edge one cannot resolve `node:` modules, so the
 * Node-only code lives in `instrumentation-node.ts`, loaded only under a condition webpack
 * can see through (`NEXT_RUNTIME === "nodejs"`). An early `return` is not enough: the import
 * after it would still be resolved for the Edge bundle and fail the whole build.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startDecoyWatch } = await import("./instrumentation-node");
    const { authTrustedOrigins } = await import("./lib/env");
    startDecoyWatch();
    // Fail at start, not on the first /api/auth request: Next loads route modules lazily, so a bad
    // AUTH_TRUSTED_ORIGINS would otherwise only surface as a 500 from the auth routes.
    authTrustedOrigins(process.env);
  }
}
