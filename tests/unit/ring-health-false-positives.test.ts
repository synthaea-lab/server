import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * A false positive is a detection an analyst marked as one, never a low-severity detection (#78).
 *
 * The routes run against an in-memory Prisma stand-in whose `detection.count` evaluates the
 * `where` it is given over the rows below, so these tests check which detections are counted, not
 * how the query is spelled. A filter key the stand-in does not know fails the test instead of
 * being ignored.
 */
type AgentRow = { id: string; tenantId: string; ring: string; lastSeen: Date };
type DetectionRow = {
  tenantId: string;
  agentId: string;
  timestamp: Date;
  severity: string;
  caseStatus: string | null;
  fleetCaseStatus: string | null;
};

const rows = { agents: [] as AgentRow[], detections: [] as DetectionRow[] };

function matchesAgent(agent: AgentRow, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === "tenantId" || key === "ring") return agent[key] === condition;
    if (key === "lastSeen") return agent.lastSeen >= (condition as { gte: Date }).gte;
    throw new Error(`stand-in does not filter agents on ${key}`);
  });
}

function matchesDetection(detection: DetectionRow, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, condition]) => {
    switch (key) {
      case "tenantId":
      case "severity":
        return detection[key] === condition;
      case "agentId":
        return (condition as { in: string[] }).in.includes(detection.agentId);
      case "timestamp":
        return detection.timestamp >= (condition as { gte: Date }).gte;
      case "case":
        return detection.caseStatus === (condition as { status: string }).status;
      case "fleetCase":
        return detection.fleetCaseStatus === (condition as { status: string }).status;
      case "OR":
        return (condition as Record<string, unknown>[]).some((branch) => matchesDetection(detection, branch));
      case "AND":
        return (condition as Record<string, unknown>[]).every((branch) => matchesDetection(detection, branch));
      default:
        throw new Error(`stand-in does not filter detections on ${key}`);
    }
  });
}

const db = vi.hoisted(() => ({
  tenant: { findMany: vi.fn() },
  agent: { count: vi.fn(), findMany: vi.fn() },
  detection: { count: vi.fn() },
  contentRelease: { findFirst: vi.fn(), update: vi.fn() },
  case: { create: vi.fn() },
  auditLog: { create: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: db }));

import { GET as checkRingHealth } from "@/app/api/cron/check-ring-health/route";
import { GET as getRingHealth } from "@/app/api/rings/[ring]/health/route";

const TENANT = "t1";
const CANARY_AGENT = "canary-agent";
const PROD_AGENT = "prod-agent";

function detections(
  agentId: string,
  count: number,
  severity: string,
  verdict: { caseStatus?: string; fleetCaseStatus?: string } = {}
): DetectionRow[] {
  return Array.from({ length: count }, () => ({
    tenantId: TENANT,
    agentId,
    timestamp: new Date(),
    severity,
    caseStatus: verdict.caseStatus ?? null,
    fleetCaseStatus: verdict.fleetCaseStatus ?? null,
  }));
}

const runCron = () =>
  checkRingHealth(
    new NextRequest("http://localhost/api/cron/check-ring-health", {
      headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
    })
  );

const ringHealth = (ring: string) =>
  getRingHealth(
    new NextRequest(`http://localhost/api/rings/${ring}/health`, { headers: { "x-tenant-id": TENANT, "x-user-id": "u1" } }),
    { params: { ring } }
  );

beforeEach(() => {
  vi.clearAllMocks();
  rows.agents = [
    { id: CANARY_AGENT, tenantId: TENANT, ring: "canary_0", lastSeen: new Date() },
    { id: PROD_AGENT, tenantId: TENANT, ring: "prod", lastSeen: new Date() },
  ];
  rows.detections = [];
  db.tenant.findMany.mockResolvedValue([{ id: TENANT, name: "tenant" }]);
  db.agent.count.mockImplementation(async ({ where }) => rows.agents.filter((a) => matchesAgent(a, where)).length);
  db.agent.findMany.mockImplementation(async ({ where }) =>
    rows.agents.filter((a) => matchesAgent(a, where)).map((a) => ({ id: a.id }))
  );
  db.detection.count.mockImplementation(
    async ({ where }) => rows.detections.filter((d) => matchesDetection(d, where)).length
  );
  db.contentRelease.findFirst.mockImplementation(async ({ where }) =>
    where.ring === "canary_0" ? { id: "r1", releaseVersion: 1, status: "active", releasedAt: new Date() } : null
  );
  db.contentRelease.update.mockResolvedValue({});
  db.case.create.mockResolvedValue({});
  db.auditLog.create.mockResolvedValue({});
});

describe("the ring-health canary gate judges false positives by analyst verdict (#78)", () => {
  it("does not halt a canary whose correct low-severity detections outnumber the FP spike threshold", async () => {
    rows.detections = [
      ...detections(CANARY_AGENT, 8, "low", { caseStatus: "open" }),
      ...detections(CANARY_AGENT, 4, "low", { caseStatus: "resolved" }),
      ...detections(CANARY_AGENT, 3, "low"),
    ];

    const body = await (await runCron()).json();

    expect(body.halted).toEqual([]);
    expect(db.contentRelease.update).not.toHaveBeenCalled();
  });

  it("halts a canary whose analyst-marked false positives spike, whatever their severity", async () => {
    rows.detections = [
      ...detections(CANARY_AGENT, 6, "high", { caseStatus: "false_positive" }),
      ...detections(CANARY_AGENT, 5, "critical", { fleetCaseStatus: "false_positive" }),
    ];

    const body = await (await runCron()).json();

    expect(body.halted).toEqual([{ tenantId: TENANT, ring: "canary_0", reason: "FP rate spike: 11 FPs (baseline: 0)" }]);
    const audit = db.auditLog.create.mock.calls[0][0].data.details.metrics;
    expect(audit.canary.falsePositiveCount).toBe(11);
    expect(audit.baseline.falsePositiveCount).toBe(0);
  });

  it("compares the canary's analyst-marked false positives with prod's, not its low-severity ones", async () => {
    rows.detections = [
      ...detections(PROD_AGENT, 1, "medium", { caseStatus: "false_positive" }),
      ...detections(PROD_AGENT, 20, "low", { caseStatus: "resolved" }),
      ...detections(CANARY_AGENT, 3, "high", { caseStatus: "false_positive" }),
      ...detections(CANARY_AGENT, 18, "low", { caseStatus: "resolved" }),
    ];

    const body = await (await runCron()).json();

    expect(body.halted).toEqual([
      { tenantId: TENANT, ring: "canary_0", reason: "FP rate increased 3.00× (3 vs baseline 1)" },
    ]);
  });
});

describe("GET /api/rings/{ring}/health reports analyst-marked false positives (#78)", () => {
  it("counts a detection in a case or fleet case marked false_positive, and no correct low-severity one", async () => {
    rows.detections = [
      ...detections(CANARY_AGENT, 3, "low", { caseStatus: "open" }),
      ...detections(CANARY_AGENT, 1, "low"),
      ...detections(CANARY_AGENT, 1, "high", { caseStatus: "false_positive" }),
      ...detections(CANARY_AGENT, 1, "critical", { fleetCaseStatus: "false_positive" }),
    ];

    const body = await (await ringHealth("canary_0")).json();

    expect(body.recentDetections).toBe(6);
    expect(body.falsePositives).toBe(2);
  });
});
