import { NextRequest, NextResponse } from "next/server";
import { verifyCronRequest } from "@/lib/cron-auth";
import { prisma } from "@/lib/prisma";
import { DEFAULT_SNAPSHOT_PARAMS, publishCommonSetSnapshot, type SnapshotParams } from "@/lib/snapshot-publish";
import { loadSnapshotSigner } from "@/lib/snapshot-manifest";
import { positiveNumberFromEnv } from "@/lib/env";

/** Provisional starting points, set from the environment until slice 6 calibrates them. */
function paramsFromEnv(): SnapshotParams {
  const d = DEFAULT_SNAPSHOT_PARAMS;
  return {
    minHosts: positiveNumberFromEnv(process.env, "SNAPSHOT_MIN_HOSTS", d.minHosts, { integer: true }),
    minHostsCovered: positiveNumberFromEnv(process.env, "SNAPSHOT_MIN_HOSTS_COVERED", d.minHostsCovered, { integer: true }),
    falsePositiveRate: positiveNumberFromEnv(process.env, "SNAPSHOT_FALSE_POSITIVE_RATE", d.falsePositiveRate, { integer: false }),
    maxBytes: positiveNumberFromEnv(process.env, "SNAPSHOT_MAX_BYTES", d.maxBytes, { integer: true }),
    maxEntries: positiveNumberFromEnv(process.env, "SNAPSHOT_MAX_ENTRIES", d.maxEntries, { integer: true }),
    minEntryFraction: positiveNumberFromEnv(process.env, "SNAPSHOT_MIN_ENTRY_FRACTION", d.minEntryFraction, { integer: false }),
  };
}

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
    const params = paramsFromEnv();
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
