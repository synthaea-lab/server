import type { Prisma, PrismaClient } from "@prisma/client";

/** One normalized telemetry sample an agent submits for the T3 corpus. */
export interface CorpusSampleInput {
  timestamp: string;
  eventType: string;
  event: Prisma.InputJsonObject;
}

export type SubmitSamplesResult =
  | { outcome: "accepted"; totalSamples: number }
  | { outcome: "notCollecting"; status: string };

/**
 * Adds a batch of samples to a tenant's corpus version, creating the version on its first
 * submit. Everything runs in one transaction, which closes three races the handler had
 * (SV-019):
 *
 * - `createMany(..., skipDuplicates)` is `INSERT ... ON CONFLICT DO NOTHING`: concurrent first
 *   submits of a version all end on the same row instead of the losers failing with P2002;
 * - the version row is read `FOR UPDATE`, so a finalize cannot commit between the status check
 *   and the insert and leave samples in a finalized version;
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
  return db.$transaction(async (tx) => {
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

    const [version] = await tx.$queryRaw<{ id: string; status: string }[]>`
      SELECT id, status FROM corpus_versions
      WHERE tenant_id = ${agent.tenantId} AND version = ${corpusVersion}
      FOR UPDATE`;
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
    const updated = await tx.corpusVersion.update({
      where: { id: version.id },
      data: { sampleCount: { increment: samples.length } },
      select: { sampleCount: true },
    });
    return { outcome: "accepted" as const, totalSamples: updated.sampleCount };
  });
}
