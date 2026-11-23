import type { Prisma, PrismaClient } from "@prisma/client";

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
class VersionNotCollecting extends Error {}

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
            status: "collecting",
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
      if (updated.length === 0) throw new VersionNotCollecting();
      return { outcome: "accepted" as const, totalSamples: updated[0].sample_count };
    });
  } catch (error) {
    if (error instanceof VersionNotCollecting) {
      const current = await db.corpusVersion.findUnique({ where: key, select: { status: true } });
      return current
        ? { outcome: "notCollecting", status: current.status }
        : { outcome: "versionGone" };
    }
    // The version (or its tenant) was deleted between the check and the insert.
    if ((error as { code?: string }).code === "P2003") return { outcome: "versionGone" };
    throw error;
  }
}
