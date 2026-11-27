import { Prisma, type PrismaClient } from "@prisma/client";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { corpusExportDir } from "@/lib/content/storage-paths";

/** Lifecycle of a corpus version: `collecting` to `finalizing` to `finalized` (`archived` is set elsewhere). */
export const CORPUS_VERSION_STATUSES = ["collecting", "finalizing", "finalized", "archived"] as const;
export type CorpusVersionStatus = (typeof CORPUS_VERSION_STATUSES)[number];

/**
 * A `finalizing` claim older than this is taken to belong to a process that died (restart,
 * SIGTERM, OOM while loading the samples), and the next finalize takes it over. Far above the
 * time an export takes, so a live finalize is not taken over in practice; if it ever is, the
 * old one notices (`FinalizeClaimLostError`) and writes nothing more.
 */
export const FINALIZE_STALE_AFTER_MS = 30 * 60 * 1000;

/** One normalized telemetry sample an agent submits for the T3 corpus. */
export interface CorpusSampleInput {
  timestamp: string;
  eventType: string;
  event: Prisma.InputJsonObject;
}

export type SubmitSamplesResult =
  | { outcome: "accepted"; totalSamples: number }
  | { outcome: "notCollecting"; status: string }
  | { outcome: "versionGone" };

/** Thrown inside the transaction so it rolls back the samples already inserted. */
class VersionNotCollectingError extends Error {}

/**
 * Adds a batch of samples to a tenant's corpus version, creating the version on its first
 * submit. Everything runs in one transaction, which closes three races the handler had
 * (SV-019):
 *
 * - `createMany(..., skipDuplicates)` is `INSERT ... ON CONFLICT DO NOTHING`: concurrent first
 *   submits of a version all end on the same row instead of the losers failing with P2002;
 * - the samples are inserted first, and the version row is locked last, by the guarded
 *   `UPDATE ... WHERE status = 'collecting'` that bumps `sampleCount`. The lock lasts only
 *   until commit, not across the whole insert, so submits do not queue on the row while a
 *   batch of up to 1000 rows is written. A finalize that claims the row first makes the
 *   `UPDATE` match nothing: the transaction rolls back and nothing is left in the version;
 * - the samples and the `sampleCount` increment commit together.
 *
 * `totalSamples` is the stored count after this batch.
 */
export async function submitSamples(
  db: PrismaClient,
  agent: { id: string; tenantId: string },
  submission: { corpusVersion: number; samples: CorpusSampleInput[] }
): Promise<SubmitSamplesResult> {
  const { corpusVersion, samples } = submission;
  const key = { tenantId_version: { tenantId: agent.tenantId, version: corpusVersion } };
  try {
    return await db.$transaction(async (tx) => {
      await tx.corpusVersion.createMany({
        data: [
          {
            tenantId: agent.tenantId,
            version: corpusVersion,
            sampleCount: 0,
            status: "collecting" satisfies CorpusVersionStatus,
            collectionStart: new Date(),
          },
        ],
        skipDuplicates: true,
      });

      const version = await tx.corpusVersion.findUnique({
        where: key,
        select: { id: true, status: true },
      });
      if (!version) return { outcome: "versionGone" as const };
      if (version.status !== "collecting") {
        return { outcome: "notCollecting" as const, status: version.status };
      }

      await tx.corpusSample.createMany({
        data: samples.map((sample) => ({
          tenantId: agent.tenantId,
          corpusVersionId: version.id,
          agentId: agent.id,
          timestamp: new Date(sample.timestamp),
          eventType: sample.eventType,
          event: sample.event,
        })),
      });
      const updated = await tx.$queryRaw<{ sample_count: number }[]>`
        UPDATE corpus_versions SET sample_count = sample_count + ${samples.length}
        WHERE id = ${version.id} AND status = 'collecting'
        RETURNING sample_count`;
      // Returning here would commit the samples: throw to roll them back.
      if (updated.length === 0) throw new VersionNotCollectingError();
      return { outcome: "accepted" as const, totalSamples: updated[0].sample_count };
    });
  } catch (error) {
    if (error instanceof VersionNotCollectingError) {
      const current = await db.corpusVersion.findUnique({ where: key, select: { status: true } });
      return current
        ? { outcome: "notCollecting", status: current.status }
        : { outcome: "versionGone" };
    }
    // The version (or its tenant) was deleted between the check and the insert.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") return { outcome: "versionGone" };
    throw error;
  }
}

export type ClaimForFinalizeResult =
  | { outcome: "claimed"; versionId: string; claimedAt: Date }
  | { outcome: "notFound" }
  | { outcome: "notCollecting"; status: string };

/** Thrown when this finalize no longer owns the claim (another finalize took it over). */
export class FinalizeClaimLostError extends Error {}

/**
 * Claims a tenant's version for finalize: `collecting` to `finalizing`, stamping
 * `finalizingSince`. The guarded update takes the row lock, so it waits for a submit that is
 * committing, and every later submit sees `finalizing` and is refused. A `finalizing` claim
 * older than `FINALIZE_STALE_AFTER_MS` is taken over, which is the way out of a process that
 * died mid-export.
 */
export async function claimForFinalize(
  db: PrismaClient,
  tenantId: string,
  versionNumber: number,
  now: Date = new Date()
): Promise<ClaimForFinalizeResult> {
  const where = { tenantId_version: { tenantId, version: versionNumber } };
  const version = await db.corpusVersion.findUnique({ where, select: { id: true, status: true } });
  if (!version) return { outcome: "notFound" };

  const staleBefore = new Date(now.getTime() - FINALIZE_STALE_AFTER_MS);
  const claimed = await db.corpusVersion.updateMany({
    where: {
      id: version.id,
      OR: [
        { status: "collecting" },
        { status: "finalizing", finalizingSince: { lt: staleBefore } },
        // No stamp: claimed before the column existed, so no live finalize can own it.
        { status: "finalizing", finalizingSince: null },
      ],
    },
    data: { status: "finalizing", finalizingSince: now },
  });
  if (claimed.count === 1) return { outcome: "claimed", versionId: version.id, claimedAt: now };

  const current = await db.corpusVersion.findUnique({ where: { id: version.id }, select: { status: true } });
  return current ? { outcome: "notCollecting", status: current.status } : { outcome: "notFound" };
}

/**
 * Puts a version whose export failed back to `collecting`. Guarded on this claim's own
 * `finalizingSince`: it never reopens a finalized version, nor a claim another finalize took over.
 */
export async function reopenAfterFailedFinalize(db: PrismaClient, versionId: string, claimedAt: Date) {
  await db.corpusVersion.updateMany({
    where: { id: versionId, status: "finalizing", finalizingSince: claimedAt },
    data: { status: "collecting", finalizingSince: null },
  });
}

export interface ExportedCorpusVersion {
  sampleCount: number;
  exportUrl: string;
  exportSha256: string;
}

/**
 * Exports a claimed version to JSONL under `storage/corpus/<tenantId>`, then marks it
 * `finalized`. The caller holds the claim, so no sample is added meanwhile. Throws
 * `FinalizeClaimLostError` if the claim was taken over, before it writes the `finalized` state.
 */
export async function exportCorpusVersion(
  db: PrismaClient,
  claim: { tenantId: string; versionId: string; versionNumber: number; claimedAt: Date }
): Promise<ExportedCorpusVersion> {
  const { tenantId, versionId, versionNumber, claimedAt } = claim;
  const samples = await db.corpusSample.findMany({
    where: { corpusVersionId: versionId },
    orderBy: { timestamp: "asc" },
    select: { timestamp: true, eventType: true, event: true, agentId: true },
  });

  const exportDir = corpusExportDir(tenantId);
  await fs.mkdir(exportDir, { recursive: true });
  const exportFilename = `corpus-v${versionNumber}.jsonl`;
  const exportPath = path.join(exportDir, exportFilename);

  // One JSON object per line.
  const jsonlLines = samples.map((sample) =>
    JSON.stringify({
      timestamp: sample.timestamp.toISOString(),
      event_type: sample.eventType,
      event: sample.event,
      agent_id: sample.agentId,
    })
  );
  await fs.writeFile(exportPath, jsonlLines.join("\n") + "\n", "utf-8");

  const fileBuffer = await fs.readFile(exportPath);
  const exportSha256 = crypto.createHash("sha256").update(fileBuffer).digest("hex");
  const exportUrl = `/storage/corpus/${tenantId}/${exportFilename}`;

  const finalized = await db.corpusVersion.updateMany({
    where: { id: versionId, status: "finalizing", finalizingSince: claimedAt },
    data: { status: "finalized", collectionEnd: new Date(), exportUrl, exportSha256, finalizingSince: null },
  });
  if (finalized.count === 0) throw new FinalizeClaimLostError();

  const stored = await db.corpusVersion.findUniqueOrThrow({
    where: { id: versionId },
    select: { sampleCount: true },
  });
  return { sampleCount: stored.sampleCount, exportUrl, exportSha256 };
}
