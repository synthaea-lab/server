import { NextRequest, NextResponse } from "next/server";
import { verifyCronRequest } from "@/lib/cron-auth";
import { prisma } from "@/lib/prisma";
import { joinOneTenant } from "@/lib/fleet-case-store";
import { perTenantResponse, runPerTenant } from "@/lib/cron/per-tenant";

/** Fixed first key of this cron's per-tenant advisory lock (`lib/cron/per-tenant.ts`): two
 * overlapping invocations would otherwise both open a case for the same group. */
const JOIN_LOCK_KEY = 62_262_001;

/** Names this cron in its log lines. */
const JOIN_LABEL = "Fleet case join";

/**
 * GET /api/cron/join-fleet-cases
 *
 * Cron endpoint (issue #62, box 1): joins each tenant's recent detections across hosts by a shared
 * entity (`lib/fleet-case.ts`: a file hash or an identity, with its caps) into fleet cases.
 * Idempotent: a run over the same detections changes nothing. An entity belongs to one fleet case
 * per tenant, so a later sighting grows it, and a detection that bridges two cases merges them
 * into the older one. A fleet case's severity is the highest of its detections and never goes
 * down. It reads detections and writes only `FleetCase`, `FleetCaseEntity` and
 * `Detection.fleetCaseId`; a detection's own host case is untouched.
 *
 * One transaction per tenant, with its own advisory lock, so one tenant's failure or slowness does
 * not stop the others (`runPerTenant`). Authentication: Bearer token (CRON_SECRET).
 * Status: 200, 207 when some tenants failed, 502 when every one did (`perTenantResponse`).
 */
export async function GET(req: NextRequest) {
  try {
    const denied = await verifyCronRequest(req);
    if (denied) return denied;

    const summary = await runPerTenant(prisma, { lockKey: JOIN_LOCK_KEY, label: JOIN_LABEL }, joinOneTenant);
    const { results } = summary;
    return perTenantResponse(JOIN_LABEL, summary, {
      fleetCasesCreated: results.reduce((n, r) => n + r.fleetCasesCreated, 0),
      fleetCasesMerged: results.reduce((n, r) => n + r.fleetCasesMerged, 0),
      detectionsJoined: results.reduce((n, r) => n + r.detectionsJoined, 0),
      moreWorkLikely: results.some((r) => r.moreWorkLikely),
    });
  } catch (error) {
    console.error("Fleet case join error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
