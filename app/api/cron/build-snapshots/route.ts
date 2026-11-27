import { NextRequest, NextResponse } from "next/server";
import { verifyCronRequest } from "@/lib/access/cron-auth";
import { prisma } from "@/lib/prisma";
import { publishCommonSetSnapshot, snapshotParamsFromEnv } from "@/lib/content/snapshot-publish";
import { loadSnapshotSigner } from "@/lib/content/snapshot-manifest";

/**
 * GET /api/cron/build-snapshots
 * Scheduled job (ADR-0033, #76 box 2): builds, guards, signs and stores each tenant's common-set
 * snapshot. Meant to run daily. Without a configured signer (`SYNTHAEA_SNAPSHOT_SIGNER`, today only
 * the public test key) it builds nothing and answers 503: the endpoints then have nothing to serve
 * and agents keep what they have. One tenant's failure does not stop the others.
 *
 * Authentication: CRON_SECRET bearer (`verifyCronRequest`).
 */
export async function GET(req: NextRequest) {
  try {
    const denied = await verifyCronRequest(req);
    if (denied) return denied;

    const signer = loadSnapshotSigner();
    if (!signer) {
      return NextResponse.json({ error: "Snapshot signing is not configured" }, { status: 503 });
    }
    const params = snapshotParamsFromEnv(process.env);
    const now = new Date();

    const tenants = await prisma.tenant.findMany({ select: { id: true } });
    const results: { tenantId: string; status: string; reason?: string }[] = [];
    for (const { id } of tenants) {
      try {
        const outcome = await publishCommonSetSnapshot(prisma, id, signer, now, params);
        results.push(
          outcome.status === "published"
            ? { tenantId: id, status: "published" }
            : { tenantId: id, status: "skipped", reason: outcome.reason }
        );
      } catch (error) {
        console.error(`Snapshot build failed for tenant ${id}:`, error);
        results.push({ tenantId: id, status: "failed" });
      }
    }
    return NextResponse.json({ tenants: results.length, results });
  } catch (error) {
    console.error("Snapshot build cron error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
