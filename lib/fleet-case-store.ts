import type { Prisma } from "@prisma/client";
import { candidateHashes, type FleetGroup, joinDetections } from "@/lib/fleet-case";
import { loadFleetPrevalence } from "@/lib/fleet-prevalence";
import { ACTIVE_CASE_STATUSES } from "@/lib/hunt-search";
import { ranksAtLeast } from "@/lib/severity";

/**
 * The database side of the fleet-case join cron (issue #62, box 1): read one tenant's recent
 * detections, let `joinDetections` (`lib/fleet-case.ts`) group them by shared entity, then write
 * the groups as fleet cases, as `lib/case-grouping-store.ts` does for #50. Every function runs
 * inside the transaction and advisory lock `runPerTenant` holds for the tenant.
 */

/** How far back detections are read: the join window is a day, so a week leaves room for a late
 * detection to join an older sighting without the sweep reading the whole table. */
const JOIN_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/** Per-tenant cap on detections read in one invocation, newest first (the same reasoning as
 * `GROUPING_BATCH_SIZE`: a bounded transaction, and the next tick continues). */
const JOIN_BATCH_SIZE = 5000;

/** One tenant's join pass. */
export interface TenantJoinResult {
  fleetCasesCreated: number;
  fleetCasesMerged: number;
  detectionsJoined: number;
  moreWorkLikely: boolean;
}

/**
 * One tenant's join pass: read its last week of detections (at most `JOIN_BATCH_SIZE`, newest first),
 * group them, and upsert each group as a fleet case.
 *
 * A closed fleet case (a status outside `ACTIVE_CASE_STATUSES`) keeps what it has but stops
 * growing (#86): its detections are left out of the join, and `upsertGroup` only looks up entities
 * of active cases. Otherwise an analyst's `false_positive` verdict would carry onto every later
 * detection that shares an entity, and a `resolved` case would grow instead of a new one
 * surfacing for triage.
 */
export async function joinOneTenant(tx: Prisma.TransactionClient, tenantId: string): Promise<TenantJoinResult> {
  const recent = await tx.detection.findMany({
    where: { tenantId, timestamp: { gte: new Date(Date.now() - JOIN_LOOKBACK_MS) } },
    select: { id: true, agentId: true, timestamp: true, severity: true, event: true, fleetCaseId: true },
    orderBy: { timestamp: "desc" },
    take: JOIN_BATCH_SIZE,
  });
  const moreWorkLikely = recent.length === JOIN_BATCH_SIZE;
  const detections = await withoutJudged(tx, recent);
  const prevalence = await loadFleetPrevalence(tx, tenantId, candidateHashes(detections));
  const groups = joinDetections(detections, prevalence);

  let fleetCasesCreated = 0;
  let fleetCasesMerged = 0;
  let detectionsJoined = 0;
  for (const group of groups) {
    const outcome = await upsertGroup(tx, tenantId, group);
    fleetCasesCreated += outcome.created ? 1 : 0;
    fleetCasesMerged += outcome.merged;
    detectionsJoined += outcome.detectionsJoined;
  }
  return { fleetCasesCreated, fleetCasesMerged, detectionsJoined, moreWorkLikely };
}

/**
 * The detections not already on a closed fleet case. A judged detection is neither moved into a
 * new case nor counted toward the two agents a group needs: a new case must stand on evidence
 * nobody has judged yet.
 */
async function withoutJudged<D extends { fleetCaseId: string | null }>(
  tx: Prisma.TransactionClient,
  detections: D[]
): Promise<D[]> {
  const caseIds = Array.from(new Set(detections.flatMap((d) => (d.fleetCaseId ? [d.fleetCaseId] : []))));
  if (caseIds.length === 0) return detections;
  const closed = await tx.fleetCase.findMany({
    where: { id: { in: caseIds }, status: { notIn: [...ACTIVE_CASE_STATUSES] } },
    select: { id: true },
  });
  const closedIds = new Set(closed.map((c) => c.id));
  return detections.filter((d) => d.fleetCaseId === null || !closedIds.has(d.fleetCaseId));
}

/**
 * Writes one group: creates a fleet case, or grows the oldest active case that already holds one
 * of the group's entities and merges the other active ones into it, then links the detections and
 * recomputes the case's counts, window and severity (never lowered). A closed case is never a
 * target or a merge source, so a group whose entities only closed cases hold opens a new case.
 */
async function upsertGroup(tx: Prisma.TransactionClient, tenantId: string, group: FleetGroup) {
  const known = await tx.fleetCaseEntity.findMany({
    where: {
      tenantId,
      fleetCase: { status: { in: [...ACTIVE_CASE_STATUSES] } },
      OR: group.entities.map((e) => ({ kind: e.kind, key: e.key })),
    },
    select: { fleetCaseId: true },
  });
  const existingIds = Array.from(new Set(known.map((k) => k.fleetCaseId)));

  let targetId: string;
  let created = false;
  let merged = 0;
  if (existingIds.length === 0) {
    const row = await tx.fleetCase.create({
      data: {
        tenantId,
        severity: group.severity,
        agentCount: group.agentIds.length,
        firstAt: group.firstAt,
        lastAt: group.lastAt,
      },
    });
    targetId = row.id;
    created = true;
  } else {
    const [oldest, ...others] = await tx.fleetCase.findMany({
      where: { id: { in: existingIds } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    targetId = oldest.id;
    if (others.length > 0) {
      await mergeInto(tx, tenantId, targetId, others.map((o) => o.id));
      merged = others.length;
    }
  }

  await tx.fleetCaseEntity.createMany({
    data: group.entities.map((e) => ({ tenantId, fleetCaseId: targetId, kind: e.kind, key: e.key })),
    skipDuplicates: true,
  });
  // Only the detections not already on this case, so a rerun does not bump `updatedAt` (the
  // staleness of a case narrative compares against it). The status condition repeats
  // `withoutJudged` at write time: an analyst may close a case while this transaction runs, and
  // the console's write does not take the cron's lock.
  const linked = await tx.detection.updateMany({
    where: {
      tenantId,
      id: { in: group.detectionIds },
      OR: [
        { fleetCaseId: null },
        { fleetCaseId: { not: targetId }, fleetCase: { status: { in: [...ACTIVE_CASE_STATUSES] } } },
      ],
    },
    data: { fleetCaseId: targetId },
  });

  // Recomputed from every detection of the case, not only this batch: it may be wider.
  const members = await tx.detection.findMany({
    where: { tenantId, fleetCaseId: targetId },
    select: { agentId: true, timestamp: true, severity: true },
  });
  const current = await tx.fleetCase.findUniqueOrThrow({ where: { id: targetId } });
  const times = members.map((m) => m.timestamp.getTime());
  const next = {
    agentCount: new Set(members.map((m) => m.agentId)).size,
    firstAt: new Date(Math.min(...times)),
    lastAt: new Date(Math.max(...times)),
    severity: members.reduce(
      (top, m) => (ranksAtLeast(m.severity, top) ? m.severity : top),
      current.severity
    ),
  };
  if (
    next.agentCount !== current.agentCount ||
    next.firstAt.getTime() !== current.firstAt.getTime() ||
    next.lastAt.getTime() !== current.lastAt.getTime() ||
    next.severity !== current.severity
  ) {
    await tx.fleetCase.update({ where: { id: targetId }, data: next });
  }
  return { created, merged, detectionsJoined: linked.count };
}

/**
 * Moves the detections and entities of `otherIds` onto `targetId`, then deletes those cases.
 * Entities are copied rather than re-pointed: once a case can be reopened (#12), two active cases
 * may list the same entity, and re-pointing both rows would break `(fleetCaseId, kind, key)`. The
 * merged cases' own rows go with them (cascade).
 */
async function mergeInto(tx: Prisma.TransactionClient, tenantId: string, targetId: string, otherIds: string[]) {
  await tx.detection.updateMany({ where: { fleetCaseId: { in: otherIds } }, data: { fleetCaseId: targetId } });
  const carried = await tx.fleetCaseEntity.findMany({
    where: { fleetCaseId: { in: otherIds } },
    select: { kind: true, key: true },
  });
  await tx.fleetCaseEntity.createMany({
    data: carried.map((e) => ({ tenantId, fleetCaseId: targetId, kind: e.kind, key: e.key })),
    skipDuplicates: true,
  });
  await tx.fleetCase.deleteMany({ where: { id: { in: otherIds } } });
}
