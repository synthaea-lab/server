/**
 * Runs once when the server starts (Next `instrumentationHook`). Next compiles this file for
 * the Node and the Edge runtime alike, and the Edge one cannot resolve `node:` modules, so the
 * Node-only code lives in `instrumentation-node.ts`, loaded only under a condition webpack
 * can see through (`NEXT_RUNTIME === "nodejs"`). An early `return` is not enough: the import
 * after it would still be resolved for the Edge bundle and fail the whole build.
 *
 * An exception from `register()` does not stop a Next 14.2 server: it only makes every request
 * fail with 500. A configuration error therefore exits the process in `instrumentation-node.ts`
 * (`process.exit` stays out of this file, which is also compiled for Edge).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { assertStartupConfig, startDecoyWatch } = await import("./instrumentation-node");
    // Validate first: the pure check, before any side effect is installed.
    assertStartupConfig(process.env);
    startDecoyWatch();
  }
}
