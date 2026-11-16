import { NextRequest, NextResponse } from "next/server";
import { verifyCronRequest } from "@/lib/cron-auth";
import { prisma } from "@/lib/prisma";
import { lakeEnabled } from "@/lib/lake-store";
import { loadLakeBacklog } from "@/lib/lake-backlog";
import {
  LAKE_BACKLOG_CASE_TITLE,
  hasOpenLakeBacklogCase,
  lakeBacklogBreach,
  lakeBacklogCaseDescription,
  lakeBacklogLimitsFromEnv,
} from "@/lib/lake-backlog-case";

/**
 * GET /api/cron/detect-lake-backlog
 * Scheduled job: opens a `high` case `Telemetry lake backlog` for a tenant whose lake write queue
 * is older than `LAKE_BACKLOG_MAX_AGE_MINUTES` (default 15) or longer than `LAKE_BACKLOG_MAX_BATCHES`
 * (default 5000), unless one is already open (issue #4, `lib/lake-backlog-case.ts`). It is its own
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
    const queued = await prisma.lakeBatch.groupBy({ by: ["tenantId"] });

    let casesCreated = 0;
    const breached: string[] = [];
    for (const { tenantId } of queued) {
      const backlog = await loadLakeBacklog(prisma, tenantId, now);
      const breach = lakeBacklogBreach(backlog, limits);
      if (!breach) continue;
      breached.push(tenantId);
      if (await hasOpenLakeBacklogCase(prisma, tenantId)) continue;
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
