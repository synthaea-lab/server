import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// `lib/auth.ts` reads the environment once, when it is imported: each case sets it, resets the module
// registry and imports the module again.
async function loadAuth(origins: string | undefined) {
  vi.stubEnv("AUTH_TRUSTED_ORIGINS", origins);
  vi.resetModules();
  return (await import("@/lib/auth")).auth;
}

// better-auth skips its origin check when it sees a test environment (read once, when it is imported).
// The tests that exercise the check import it as it runs in production; `afterEach` puts the
// environment back.
async function loadAuthWithOriginCheck(origins: string) {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("TEST", undefined);
  return loadAuth(origins);
}

// The first import of better-auth transforms the whole package (vitest.config.ts inlines it), which
// takes several seconds on a slow runner. Pay it here, not inside the first test's 5 s budget.
beforeAll(async () => {
  await import("@/lib/auth");
}, 60_000);

afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env.AUTH_TRUSTED_ORIGINS;
  vi.resetModules();
});

// A request that carries a session cookie, which is what better-auth's origin check applies to.
function signOutFrom(origin: string) {
  return new Request("http://localhost:3000/api/auth/sign-out", {
    method: "POST",
    headers: { origin, cookie: "better-auth.session_token=not-a-real-session", "content-type": "application/json" },
    body: "{}",
  });
}

describe("lib/auth trusted origins", () => {
  it("keeps the two localhost origins when AUTH_TRUSTED_ORIGINS is unset", async () => {
    const auth = await loadAuth(undefined);
    expect(auth.options.trustedOrigins).toEqual(["http://localhost:3000", "http://localhost:8443"]);
  });

  it("trusts the configured production origin and no localhost", async () => {
    const auth = await loadAuth("https://console.example.com");
    expect(auth.options.trustedOrigins).toEqual(["https://console.example.com"]);
  });

  it("fails at import on a value that is not an origin", async () => {
    await expect(loadAuth("console.example.com")).rejects.toThrow(/AUTH_TRUSTED_ORIGINS/);
  });

  it("refuses a cookie-bearing request from a foreign Origin", async () => {
    const auth = await loadAuthWithOriginCheck("https://console.example.com");
    const response = await auth.handler(signOutFrom("https://evil.example.com"));
    expect(response.status).toBe(403);
  });

  it("accepts a cookie-bearing request from a configured Origin", async () => {
    const auth = await loadAuthWithOriginCheck("https://console.example.com");
    const response = await auth.handler(signOutFrom("https://console.example.com"));
    expect(response.status).toBe(200);
  });
});
