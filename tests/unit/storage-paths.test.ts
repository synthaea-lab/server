import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { keyRotationFile } from "@/lib/key-rotation";
import { releaseArtifactFile } from "@/lib/release-manifest";
import {
  artifactFile,
  artifactsDir,
  corpusExportDir,
  storagePath,
  storageRoot,
} from "@/lib/storage-paths";

const SHA = "a".repeat(64);

let originalCwd: string;
let sandbox: string;

beforeEach(() => {
  originalCwd = process.cwd();
  sandbox = mkdtempSync(path.join(tmpdir(), "storage-paths-"));
  process.chdir(sandbox);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(sandbox, { recursive: true, force: true });
});

/** The expression every caller used before #53, evaluated in the current working directory. */
function before(...segments: string[]): string {
  return path.join(process.cwd(), "storage", ...segments);
}

describe("storage paths (SV-021, #53): the same paths the callers built inline", () => {
  it("roots everything under storage/ in the working directory", () => {
    expect(storageRoot()).toBe(before());
    expect(storagePath("manifests", "release-prod-v1.json")).toBe(before("manifests", "release-prod-v1.json"));
  });

  it("names the artifact store and one artifact by its SHA-256", () => {
    expect(artifactsDir()).toBe(before("artifacts"));
    expect(artifactFile(SHA)).toBe(before("artifacts", SHA));
  });

  it("names a tenant's corpus export directory", () => {
    expect(corpusExportDir("t1")).toBe(before("corpus", "t1"));
  });

  it("keeps the key-rotation and release paths their modules returned", () => {
    expect(keyRotationFile("prod")).toBe(before("key-rotations", "prod.json"));
    expect(keyRotationFile("not-a-ring")).toBeNull();
    expect(releaseArtifactFile(3, "lib/libort.so.1")).toBe(before("releases", "v3", "lib", "libort.so.1"));
  });

  it("reads the working directory on each call, not when the module loads", () => {
    const first = storageRoot();
    const other = mkdtempSync(path.join(tmpdir(), "storage-paths-other-"));
    try {
      process.chdir(other);
      expect(storageRoot()).toBe(path.join(process.cwd(), "storage"));
      expect(storageRoot()).not.toBe(first);
    } finally {
      process.chdir(sandbox);
      rmSync(other, { recursive: true, force: true });
    }
  });
});
