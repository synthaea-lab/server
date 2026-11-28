import { Prisma, type PrismaClient } from "@prisma/client";
import {
  describeRunError,
  executeHunt,
  HUNT_RUNS_KEPT,
  HUNT_TRANSACTION_TIMEOUT_MS,
  MAX_RUNS_PER_TENANT_PER_MINUTE,
  RunUnavailableError,
  type ExecuteOptions,
} from "@/lib/hunt/hunt";
import { isEventQuery, parseSavedHuntQuery } from "@/lib/hunt/input";
import { runEventHuntWithinLimit, type EventHuntResult } from "@/lib/hunt/events-search";
import { eventArchiveFromEnv } from "@/lib/lake/env";
import type { EventArchive } from "@/lib/lake/store";
import { notifyHuntNewMatches } from "@/lib/notify/hunt-matches";

/**
 * Running saved hunts and keeping their history (#61): the part of the hunt code that talks to the
 * database's run history and to the notification outbox. **Server only.** The query model, its
 * validation and the constants stay in `lib/hunt/hunt.ts`, which client components import; this module
 * reaches `node:crypto` through the outbox, so a client component that imported it would break the
 * browser bundle (#926). `tests/unit/client-bundle-imports.test.ts` fails when one does.
 */

export type RunTrigger = "manual" | "schedule";

/**
 * `ExecuteOptions` (test seams of a detection hunt) and, for a hunt over the event archive, what can
 * be read: `archive` defaults to the environment's (`eventArchiveFromEnv`), read only when the hunt
 * is an event hunt. `eventTimeoutMs` is the seam for the archive read's deadline.
 */
export type RunOptions = ExecuteOptions & { archive?: EventArchive; eventTimeoutMs?: number };

/** Why a run of an event hunt did not read the archive: recorded as the run's error, so the history says so. */
const ARCHIVE_UNAVAILABLE = {
  lake_off: "the event archive is off (the telemetry lake is not configured), so the hunt could not run",
  no_reader: "the event archive cannot be read (the telemetry lake is on but its store has no reader)",
  busy: "the tenant already has its searches in flight, so the hunt did not read the archive; it runs again on the next schedule or on request",
} as const;

type HuntToRun = { id: string; tenantId: string; version: number; query: unknown };

/**
 * Runs a hunt and appends its HuntRun. A failing query (timeout, database error) is
 * recorded on the run, not thrown: the history says the hunt could not run, which is
 * itself worth knowing on a schedule.
 *
 * The run's row is written when it starts (`finishedAt` null) and completed when it
 * ends, so a run in flight is visible in the history and counted against the tenant's
 * allowance. A run whose server died is left with `finishedAt` null; it is never taken
 * for the previous run (see `newSince` below).
 */
export async function runHunt(
  prisma: PrismaClient,
  hunt: HuntToRun,
  trigger: RunTrigger,
  now: Date = new Date(),
  options: RunOptions = {}
) {
  // With no limit a run is always started, so this is never null.
  return (await startAndExecute(prisma, hunt, trigger, now, options, undefined))!;
}

/**
 * Like `runHunt`, but starts the run only if `tenantId` has started fewer than `limit`
 * runs in the last minute, and returns null when it has. The check and the insert of the
 * run's row are one step under a per-tenant lock, so requests sent together cannot all
 * see "below the limit" and all run: the limit holds for parallel requests, not only for
 * runs chained one after another.
 */
export async function runHuntWithinLimit(
  prisma: PrismaClient,
  hunt: HuntToRun,
  trigger: RunTrigger,
  limit: number = MAX_RUNS_PER_TENANT_PER_MINUTE,
  now: Date = new Date(),
  options: RunOptions = {}
) {
  return startAndExecute(prisma, hunt, trigger, now, options, limit);
}

async function startAndExecute(
  prisma: PrismaClient,
  hunt: HuntToRun,
  trigger: RunTrigger,
  now: Date,
  options: RunOptions,
  limit: number | undefined
) {
  // The previous run is the last one that produced a result: a run that is still going,
  // or that never finished, has nothing to compare with and must not move the baseline.
  const previous = await prisma.huntRun.findFirst({
    where: { huntId: hunt.id, tenantId: hunt.tenantId, error: null, finishedAt: { not: null } },
    orderBy: { startedAt: "desc" },
    select: { startedAt: true },
  });
  const started = await prisma.$transaction(
    async (tx) => {
      if (limit !== undefined) {
        // Serializes the count and the insert for this tenant only. Held until the
        // transaction ends, which is a few milliseconds: the search runs after it.
        await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`hunt_runs:${hunt.tenantId}`}))`);
        const recent = await tx.huntRun.count({
          where: { tenantId: hunt.tenantId, startedAt: { gt: new Date(now.getTime() - 60_000) } },
        });
        if (recent >= limit) return null;
      }
      return tx.huntRun.create({
        data: {
          huntId: hunt.id,
          tenantId: hunt.tenantId,
          startedAt: now,
          queryVersion: hunt.version,
          query: (hunt.query ?? {}) as Prisma.InputJsonValue,
          sampleDetectionIds: [],
          trigger,
        },
      });
    },
    { timeout: HUNT_TRANSACTION_TIMEOUT_MS, maxWait: HUNT_TRANSACTION_TIMEOUT_MS }
  );
  if (!started) return null;
  try {
    // Validated here, inside the try, so one hunt whose stored query no longer parses
    // is a failed run in its history and not an error that stops the cron's batch.
    const data = await executeRun(prisma, hunt, now, previous?.startedAt ?? null, options);
    const run = await prisma.huntRun.update({ where: { id: started.id }, data: { finishedAt: new Date(), ...data } });
    // After the run is recorded. `notifyHuntNewMatches` does not throw: a notification problem
    // is logged, never a second (failed) run row for the same run (#863).
    await notifyHuntNewMatches(prisma, hunt, run);
    return run;
  } catch (error) {
    console.error("Hunt run failed:", hunt.id, error);
    return prisma.huntRun.update({
      where: { id: started.id },
      data: { finishedAt: new Date(), sampleDetectionIds: [], sampleEvents: [], error: describeRunError(error) },
    });
  }
}

/**
 * Runs a hunt's query, over the detection store or the event archive, and returns the columns of the
 * run that hold its result. Validated here, so one hunt whose stored query no longer parses is a
 * failed run in its history; an archive that cannot be read is a `RunUnavailableError`.
 */
async function executeRun(prisma: PrismaClient, hunt: HuntToRun, now: Date, newSince: Date | null, options: RunOptions) {
  const query = parseSavedHuntQuery(hunt.query);
  if (!isEventQuery(query)) {
    const result = await executeHunt(prisma, hunt.tenantId, query, now, newSince, options);
    return { matchCount: result.matchCount, newMatchCount: result.newMatchCount, sampleDetectionIds: result.sample };
  }
  const outcome = await runEventHuntWithinLimit(prisma, options.archive ?? eventArchiveFromEnv(), hunt.tenantId, query, now, newSince, {
    timeoutMs: options.eventTimeoutMs,
    beforeRead: options.beforeQuery,
  });
  if (outcome.status !== "ok") throw new RunUnavailableError(ARCHIVE_UNAVAILABLE[outcome.status]);
  const r: EventHuntResult = outcome.result;
  return {
    matchCount: r.matchCount,
    newMatchCount: r.newMatchCount,
    sampleEvents: r.sample as unknown as Prisma.InputJsonValue,
    truncated: r.truncated,
    incomplete: r.incomplete,
  };
}

/** Active scheduled hunts whose last run (any outcome) is older than their schedule, or that never ran. */
export async function dueHunts(prisma: PrismaClient, now: Date = new Date()) {
  const scheduled = await prisma.hunt.findMany({
    where: { active: true, scheduleMinutes: { not: null } },
    orderBy: { createdAt: "asc" },
  });
  if (scheduled.length === 0) return [];
  // One grouped query for every hunt's last run, not one per hunt.
  const lastRuns = await prisma.huntRun.groupBy({
    by: ["huntId"],
    where: { huntId: { in: scheduled.map((h) => h.id) } },
    _max: { startedAt: true },
  });
  const last = new Map(lastRuns.map((r) => [r.huntId, r._max.startedAt]));
  return scheduled.filter((hunt) => {
    const lastStart = last.get(hunt.id);
    const intervalMs = (hunt.scheduleMinutes as number) * 60_000;
    return !lastStart || now.getTime() - lastStart.getTime() >= intervalMs;
  });
}

/** Deletes all but the newest `keep` runs of every hunt; returns how many went. */
export async function pruneHuntRuns(prisma: PrismaClient, keep: number = HUNT_RUNS_KEPT): Promise<number> {
  const result = await prisma.$executeRaw`
    DELETE FROM hunt_runs WHERE id IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY hunt_id ORDER BY started_at DESC, id) AS rn
        FROM hunt_runs
      ) ranked WHERE rn > ${keep}
    )`;
  return Number(result);
}
