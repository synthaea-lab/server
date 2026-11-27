import { NextRequest, NextResponse } from "next/server";
import { verifyCronRequest } from "@/lib/access/cron-auth";
import { prisma } from "@/lib/prisma";
import { lakeEnabled } from "@/lib/lake/store";
import { loadLakeBacklogs } from "@/lib/lake/backlog";
import {
  LAKE_BACKLOG_CASE_TITLE,
  hasActiveLakeBacklogCase,
  lakeBacklogBreach,
  lakeBacklogCaseDescription,
  lakeBacklogLimitsFromEnv,
} from "@/lib/lake/backlog-case";

/**
 * GET /api/cron/detect-lake-backlog
 * Scheduled job: opens a `high` case `Telemetry lake backlog` for a tenant whose lake write queue
 * is older than `LAKE_BACKLOG_MAX_AGE_MINUTES` (default 15) or longer than `LAKE_BACKLOG_MAX_BATCHES`
 * (default 5000), unless one is already open or investigating (issue #4, `lib/lake/backlog-case.ts`). It is its own
 * job and not part of `write-lake`: a writer that is stuck or not scheduled never reaches its own check.
 *
 * Authentication: CRON_SECRET bearer (`verifyCronRequest`).
 * 503 when the lake is off (`LAKE_DIR` / `LAKE_S3_BUCKET` unset): nothing is queued.
 */
export async function GET(req: NextRequest) {
  try {
    const denied = await verifyCronRequest(req);
    if (denied) return denied;

    if (!lakeEnabled()) {
      return NextResponse.json({ error: "The telemetry lake is off (LAKE_DIR and LAKE_S3_BUCKET are not set)" }, { status: 503 });
    }

    const limits = lakeBacklogLimitsFromEnv();
    const now = new Date();
    // Only tenants with something queued can be over a limit.
    const queued = await loadLakeBacklogs(prisma, now);

    let casesCreated = 0;
    const breached: string[] = [];
    for (const { tenantId, ...backlog } of queued) {
      const breach = lakeBacklogBreach(backlog, limits);
      if (!breach) continue;
      breached.push(tenantId);
      // Check then create is not atomic: two overlapping runs could open two cases. At a 5-minute
      // schedule that is rare and costs one duplicate case, so no lock is taken.
      if (await hasActiveLakeBacklogCase(prisma, tenantId)) continue;
      await prisma.case.create({
        data: {
          tenantId,
          title: LAKE_BACKLOG_CASE_TITLE,
          description: lakeBacklogCaseDescription(backlog, breach, limits),
          severity: "high",
          status: "open",
        },
      });
      casesCreated++;
    }

    return NextResponse.json({ tenantsQueued: queued.length, breached: breached.length, casesCreated, ...limits });
  } catch (error) {
    console.error("Lake backlog detection error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
