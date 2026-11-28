import type { PrismaClient } from "@prisma/client";

/**
 * The telemetry archive's write queue for one tenant (issue #4): batches the ingest
 * route accepted that `write-lake` has not written yet. The agent's `2xx` means "durably queued",
 * not "in the lake", so the age of the oldest queued batch is the lag a
 * stuck writer or a down object store shows as. Nothing bounds the queue; this makes its growth
 * visible and decides nothing about what to do at a bound.
 */
export type LakeBacklog = {
  batches: number;
  events: number;
  /** Age of the oldest queued batch in ms; `null` when the queue holds none for this tenant. */
  oldestAgeMs: number | null;
};

type Aggregate = { batches: number; events: number | null; oldest: Date | null };

function toBacklog({ batches, events, oldest }: Aggregate, now: Date): LakeBacklog {
  return {
    batches,
    events: events ?? 0,
    // A clock set back can put the oldest batch in the future: never show a negative age.
    oldestAgeMs: oldest ? Math.max(0, now.getTime() - oldest.getTime()) : null,
  };
}

export async function loadLakeBacklog(prisma: PrismaClient, tenantId: string, now: Date): Promise<LakeBacklog> {
  const agg = await prisma.lakeBatch.aggregate({
    where: { tenantId },
    _count: { _all: true },
    _sum: { eventCount: true },
    _min: { receivedAt: true },
  });
  return toBacklog({ batches: agg._count._all, events: agg._sum.eventCount, oldest: agg._min.receivedAt }, now);
}

/** The queue of every tenant that has something queued, in one scan of `lake_batches` (no `tenantId` index to lean on). */
export async function loadLakeBacklogs(prisma: PrismaClient, now: Date): Promise<Array<{ tenantId: string } & LakeBacklog>> {
  const rows = await prisma.lakeBatch.groupBy({
    by: ["tenantId"],
    _count: { _all: true },
    _sum: { eventCount: true },
    _min: { receivedAt: true },
  });
  return rows.map((row) => ({
    tenantId: row.tenantId,
    ...toBacklog({ batches: row._count._all, events: row._sum.eventCount, oldest: row._min.receivedAt }, now),
  }));
}
