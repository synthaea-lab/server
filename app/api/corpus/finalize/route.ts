import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireTenantAdmin } from "@/lib/access/admin-auth";
import { z } from "zod";
import {
  claimForFinalize,
  exportCorpusVersion,
  FinalizeClaimLostError,
  reopenAfterFailedFinalize,
} from "@/lib/ingest/corpus";

const FinalizeSchema = z.object({
  version: z.number().int().min(1),
});

/**
 * POST /api/corpus/finalize
 * Admin endpoint: Finalize corpus version and export to JSONL
 *
 * Authentication: better-auth session, `owner` or `admin` member of the tenant (#837)
 * Request body: { version: number }
 * Response: { status: "finalized", version, sampleCount, exportUrl, exportSha256 }
 */
export async function POST(req: NextRequest) {
  try {
    const authed = await requireTenantAdmin(req);
    if ("response" in authed) return authed.response;
    const { tenantId, userId } = authed;

    // Parse request body
    const body = await req.json();
    const validation = FinalizeSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        { error: "Invalid request", details: validation.error.errors },
        { status: 400 }
      );
    }

    const { version: versionNumber } = validation.data;

    // Claim the version before exporting (see `claimForFinalize`): the export then reads every
    // sample that `sampleCount` counts. A claim left by a process that died is taken over.
    const claim = await claimForFinalize(prisma, tenantId, versionNumber);
    if (claim.outcome === "notFound") {
      return NextResponse.json({ error: "Corpus version not found" }, { status: 404 });
    }
    if (claim.outcome === "notCollecting") {
      return NextResponse.json(
        {
          error:
            claim.status === "finalizing" ? "Corpus finalize in progress" : "Corpus already finalized",
          message: `Version ${versionNumber} is already in status: ${claim.status}`,
        },
        { status: 409 }
      );
    }

    let exported;
    try {
      exported = await exportCorpusVersion(prisma, {
        tenantId,
        versionId: claim.versionId,
        versionNumber,
        claimedAt: claim.claimedAt,
      });
    } catch (error) {
      if (error instanceof FinalizeClaimLostError) {
        return NextResponse.json(
          {
            error: "Corpus finalize in progress",
            message: `Version ${versionNumber} was taken over by another finalize`,
          },
          { status: 409 }
        );
      }
      // Nothing was finalized: reopen the version so submits and a retry work again.
      await reopenAfterFailedFinalize(prisma, claim.versionId, claim.claimedAt);
      throw error;
    }

    // Audit log. A failure here does not reopen the version: it is already finalized.
    await prisma.auditLog.create({
      data: {
        tenantId,
        userId,
        action: "corpus.version.finalize",
        resource: `corpus_versions/${claim.versionId}`,
        details: {
          version: versionNumber,
          sampleCount: exported.sampleCount,
          exportUrl: exported.exportUrl,
          exportSha256: exported.exportSha256,
        },
      },
    });

    return NextResponse.json({
      status: "finalized",
      version: versionNumber,
      sampleCount: exported.sampleCount,
      exportUrl: exported.exportUrl,
      exportSha256: exported.exportSha256,
    });
  } catch (error) {
    console.error("Corpus finalize error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
