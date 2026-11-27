import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

/**
 * Next compiles `instrumentation.ts` for the Node AND the Edge runtime. The Edge one cannot
 * resolve `node:` modules, and when it fails the whole server stops answering (every route
 * returned 500, found in the lab run of #81, 2026-10-08). The unit tests never go through
 * Next's bundler, so this pins the two rules that keep the Edge bundle clean.
 */
const root = join(__dirname, "..", "..");
const entry = readFileSync(join(root, "instrumentation.ts"), "utf8");

describe("instrumentation.ts", () => {
  it("imports nothing at the top level: the Edge bundle would resolve it", () => {
    expect(entry).not.toMatch(/^\s*import\s/m);
  });

  it("loads the Node-only code only inside a positive NEXT_RUNTIME === nodejs check", () => {
    // An early `return` is not enough: the import after it is still resolved for Edge.
    expect(entry).toMatch(
      /if \(process\.env\.NEXT_RUNTIME === "nodejs"\) \{[\s\S]*?import\("\.\/instrumentation-node"\)/
    );
    expect(entry).not.toMatch(/NEXT_RUNTIME !== "nodejs"/);
  });

  it("keeps the Node-only modules out of instrumentation.ts itself", () => {
    expect(entry).not.toMatch(/@\/lib\/(decoy|prisma)|node:crypto/);
  });
});

describe("the production image", () => {
  it("leaves SIGTERM to instrumentation-node, not to Next's own handler (NEXT_MANUAL_SIG_HANDLE)", () => {
    const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");
    const runner = dockerfile.slice(dockerfile.lastIndexOf("CMD"));
    expect(dockerfile).toMatch(/^ENV NEXT_MANUAL_SIG_HANDLE true$/m);
    expect(runner).toContain('"server.js"');
    expect(dockerfile.indexOf("NEXT_MANUAL_SIG_HANDLE")).toBeLessThan(dockerfile.lastIndexOf("CMD"));
  });
});

describe("assertStartupConfig", () => {
  const exit = (code: number): never => {
    throw new Error(`exit ${code}`);
  };

  it("exits with status 1 and logs the cause on a bad AUTH_TRUSTED_ORIGINS", async () => {
    const { assertStartupConfig } = await import("../../instrumentation-node");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => assertStartupConfig({ AUTH_TRUSTED_ORIGINS: "console.example.com" }, exit)).toThrow("exit 1");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("AUTH_TRUSTED_ORIGINS"));
    log.mockRestore();
  }, 30_000);

  it("exits with status 1 on a bad PORT or SNAPSHOT_* value", async () => {
    const { assertStartupConfig } = await import("../../instrumentation-node");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => assertStartupConfig({ PORT: "http" }, exit)).toThrow("exit 1");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("PORT"));
    expect(() => assertStartupConfig({ SNAPSHOT_MAX_BYTES: "1.5" }, exit)).toThrow("exit 1");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("SNAPSHOT_MAX_BYTES"));
    log.mockRestore();
  });

  it("does not require a secret: an unset secret is a closed door, not a startup error", async () => {
    const { assertStartupConfig } = await import("../../instrumentation-node");
    expect(() => assertStartupConfig({ PORT: "8080" }, exit)).not.toThrow();
  });

  it("does nothing on a valid or unset value", async () => {
    const { assertStartupConfig } = await import("../../instrumentation-node");
    expect(() => assertStartupConfig({ AUTH_TRUSTED_ORIGINS: "https://console.example.com" }, exit)).not.toThrow();
    expect(() => assertStartupConfig({}, exit)).not.toThrow();
  });
});

describe("instrumentation.ts boot order", () => {
  it("validates the configuration before the decoy side effects start", () => {
    expect(entry.indexOf("assertStartupConfig(")).toBeGreaterThan(-1);
    expect(entry.indexOf("assertStartupConfig(")).toBeLessThan(entry.indexOf("startDecoyWatch()"));
  });
});
