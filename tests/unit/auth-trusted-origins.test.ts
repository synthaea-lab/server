import { afterEach, describe, expect, it, vi } from "vitest";

// `lib/auth.ts` reads the environment once, when it is imported: each case sets it, resets the module
// registry and imports the module again.
async function loadAuth(origins: string | undefined) {
  if (origins === undefined) delete process.env.AUTH_TRUSTED_ORIGINS;
  else process.env.AUTH_TRUSTED_ORIGINS = origins;
  vi.resetModules();
  return (await import("@/lib/auth")).auth;
}

afterEach(() => {
  delete process.env.AUTH_TRUSTED_ORIGINS;
  vi.resetModules();
});

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
});
