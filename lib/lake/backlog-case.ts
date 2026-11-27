import type { PrismaClient } from "@prisma/client";
import { positiveIntFromEnv } from "@/lib/env";
import { ACTIVE_CASE_STATUSES } from "@/lib/hunt/search";
import type { LakeBacklog } from "@/lib/lake/backlog";

/**
 * The alert for the telemetry lake's write queue (issue #4, ADR-0041). The queue (`lake_batches`)
 * has no bound: a stuck writer or a down object store fills the Postgres disk. The ingest route is
 * not made to refuse uploads over it, because an agent that is refused may lose what it sent; the
 * queue grows, and this opens a case so someone looks before the disk is full.
 *
 * A tenant is over the line when its oldest queued batch is older than `maxAgeMs` or it queues more
 * than `maxBatches`. One active case per tenant: while a case titled `LAKE_BACKLOG_CASE_TITLE` is
 * `open` or `investigating`, the cron opens no other one. It does not close the case when the queue drains; an analyst
 * does, like any other case.
 */
export const LAKE_BACKLOG_CASE_TITLE = "Telemetry lake backlog";

export const DEFAULT_BACKLOG_MAX_AGE_MS = 15 * 60 * 1000;
export const DEFAULT_BACKLOG_MAX_BATCHES = 5_000;

export type LakeBacklogLimits = { maxAgeMs: number; maxBatches: number };

/** Which limit the backlog crossed, or `null` when it is within both. The age is checked first. */
export function lakeBacklogBreach(backlog: LakeBacklog, limits: LakeBacklogLimits): "age" | "batches" | null {
  if (backlog.oldestAgeMs !== null && backlog.oldestAgeMs > limits.maxAgeMs) return "age";
  if (backlog.batches > limits.maxBatches) return "batches";
  return null;
}

export function lakeBacklogCaseDescription(backlog: LakeBacklog, breach: "age" | "batches", limits: LakeBacklogLimits): string {
  const minutes = backlog.oldestAgeMs === null ? 0 : Math.round(backlog.oldestAgeMs / 60_000);
  const why =
    breach === "age"
      ? `the oldest queued batch is ${minutes} min old (limit ${Math.round(limits.maxAgeMs / 60_000)} min)`
      : `${backlog.batches} batches are queued (limit ${limits.maxBatches})`;
  return (
    `The telemetry lake's write queue is not draining: ${why}. ` +
    `Queued: ${backlog.batches} batches, ${backlog.events} events. ` +
    "The writer (`write-lake`) may be stuck or not scheduled, or the object store may be down; " +
    "the queue lives in Postgres, so it keeps growing until the writer runs."
  );
}

export function lakeBacklogLimitsFromEnv(env: Record<string, string | undefined> = process.env): LakeBacklogLimits {
  return {
    maxAgeMs: positiveIntFromEnv(env, "LAKE_BACKLOG_MAX_AGE_MINUTES", DEFAULT_BACKLOG_MAX_AGE_MS / 60_000) * 60_000,
    maxBatches: positiveIntFromEnv(env, "LAKE_BACKLOG_MAX_BATCHES", DEFAULT_BACKLOG_MAX_BATCHES),
  };
}

/** Whether the tenant already has an active (`ACTIVE_CASE_STATUSES`: `open` or `investigating`) lake-backlog case. */
export async function hasActiveLakeBacklogCase(db: Pick<PrismaClient, "case">, tenantId: string): Promise<boolean> {
  const active = await db.case.findFirst({
    where: { tenantId, status: { in: [...ACTIVE_CASE_STATUSES] }, title: LAKE_BACKLOG_CASE_TITLE },
    select: { id: true },
  });
  return active !== null;
}
