import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { extractEnrollmentId } from "@/lib/tenant";
import { submitSamples } from "@/lib/corpus";
import { z } from "zod";

const CorpusSampleSchema = z.object({
  timestamp: z.string().datetime(),
  eventType: z.string(),
  event: z.record(z.any()), // Normalized schema::Event
});

const CorpusSubmissionSchema = z.object({
  corpusVersion: z.number().int().min(1),
  samples: z.array(CorpusSampleSchema).min(1).max(1000), // Max 1000 samples per batch
});

/**
 * POST /api/corpus/submit
 * Agent endpoint: Submit benign telemetry samples for T3 corpus curation
 *
 * Authentication: mTLS (X-Client-Cert-Verified + X-Client-Cert-Subject)
 * Request body: { corpusVersion: number, samples: Array<CorpusSample> }
 * Response: { status: "accepted", samplesAccepted: number }
 */
export async function POST(req: NextRequest) {
  try {
    // Verify mTLS authentication
    const certVerified = req.headers.get("X-Client-Cert-Verified");
    const certSubject = req.headers.get("X-Client-Cert-Subject");

    if (certVerified !== "SUCCESS" || !certSubject) {
      return NextResponse.json(
        { error: "Unauthorized - mTLS authentication required" },
        { status: 401 }
      );
    }

    const enrollmentId = extractEnrollmentId(certSubject);
    if (!enrollmentId) {
      return NextResponse.json(
        { error: "Invalid certificate subject" },
        { status: 400 }
      );
    }

    // Find agent to get tenant context
    const agent = await prisma.agent.findUnique({
      where: { enrollmentId },
      select: { id: true, tenantId: true },
    });

    if (!agent) {
      return NextResponse.json(
        { error: "Agent not enrolled" },
        { status: 403 }
      );
    }

    // Parse request body
    const body = await req.json();
    const validation = CorpusSubmissionSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        { error: "Invalid request", details: validation.error.errors },
        { status: 400 }
      );
    }

    const { corpusVersion, samples } = validation.data;

    const result = await submitSamples(prisma, agent, { corpusVersion, samples });

    if (result.outcome === "versionGone") {
      return NextResponse.json({ error: "Corpus version not found" }, { status: 404 });
    }
    if (result.outcome === "notCollecting") {
      return NextResponse.json(
        {
          error: result.status === "finalizing" ? "Corpus version is being finalized" : "Corpus version is finalized",
          message: `Version ${corpusVersion} is no longer accepting samples (status: ${result.status})`,
        },
        { status: 409 }
      );
    }

    return NextResponse.json({
      status: "accepted",
      samplesAccepted: samples.length,
      corpusVersion,
      totalSamples: result.totalSamples,
    });
  } catch (error) {
    console.error("Corpus submission error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
