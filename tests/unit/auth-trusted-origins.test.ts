import { afterEach, describe, expect, it, vi } from "vitest";

// `lib/auth.ts` reads the environment once, when it is imported: each case sets it, resets the module
// registry and imports the module again.
async function loadAuth(origins: string | undefined) {
  if (origins === undefined) delete process.env.AUTH_TRUSTED_ORIGINS;
  else process.env.AUTH_TRUSTED_ORIGINS = origins;
  vi.resetModules();
  return (await import("@/lib/auth")).auth;
}

// The variables the tests set, put back to what they were so no other file sees a change.
const initial = { AUTH_TRUSTED_ORIGINS: process.env.AUTH_TRUSTED_ORIGINS, NODE_ENV: process.env.NODE_ENV, TEST: process.env.TEST };

// better-auth skips its origin check when it sees a test environment (read once, when it is imported).
// The tests that exercise the check import it as it runs in production; `afterEach` restores both.
async function loadAuthWithOriginCheck(origins: string) {
  (process.env as Record<string, string | undefined>).NODE_ENV = "production";
  delete process.env.TEST;
  return loadAuth(origins);
}

afterEach(() => {
  for (const [name, value] of Object.entries(initial)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
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

  it("does not refuse a cookie-bearing request from a configured Origin on the origin check", async () => {
    const auth = await loadAuthWithOriginCheck("https://console.example.com");
    const response = await auth.handler(signOutFrom("https://console.example.com"));
    expect(response.status).not.toBe(403);
  });
});
