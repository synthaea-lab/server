/**
 * Where the server keeps what it stores on local disk (SV-021, #53): one root, and one function
 * per layout, instead of `path.join(process.cwd(), "storage", …)` repeated at every caller.
 *
 * The root is read on each call, not when the module loads: tests run each case in a throwaway
 * working directory and expect the paths to follow it.
 *
 * These functions only join. Each caller still validates the names it passes in (a SHA-256, a
 * tenant id, a ring, a release entry path) before calling.
 */
import path from "node:path";

/** The storage root: `storage/` under the process's working directory. */
export function storageRoot(): string {
  return path.join(process.cwd(), "storage");
}

/** A path under the storage root, from segments the caller has already validated. */
export function storagePath(...segments: string[]): string {
  return path.join(storageRoot(), ...segments);
}

/** The content-addressed artifact store (`storage/artifacts`, #804). */
export function artifactsDir(): string {
  return storagePath("artifacts");
}

/**
 * One artifact of the store, named by its SHA-256, not by its manifest `path` (#804): every
 * release's bytes stay available under their own hash for as long as any release still
 * references them, so a corrective release over a path a later release modified needs no
 * manual restoration step.
 */
export function artifactFile(sha256: string): string {
  return path.join(artifactsDir(), sha256);
}

/** The directory a tenant's corpus versions are exported to (`storage/corpus/<tenantId>`). */
export function corpusExportDir(tenantId: string): string {
  return storagePath("corpus", tenantId);
}
