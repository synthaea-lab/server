import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { cleanDatabase, createTestAgent, createTestTenant, prisma } from "../helpers/db";
import { GET } from "@/app/api/cron/detect-lake-backlog/route";
import { enqueueLakeBatch } from "@/lib/lake-writer";

function cronRequest() {
  return new NextRequest("http://localhost/api/cron/detect-lake-backlog", {
    headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
  });
}

const ev = (n: number) => ({ type: "exec", meta: { timestamp_ns: (Date.now() + n) * 1_000_000 }, image_path: `/bin/${n}` });
const MINUTES_AGO = (m: number) => new Date(Date.now() - m * 60_000);

describe("GET /api/cron/detect-lake-backlog", () => {
  const saved = { dir: process.env.LAKE_DIR, bucket: process.env.LAKE_S3_BUCKET };

  beforeEach(async () => {
    await cleanDatabase();
    delete process.env.LAKE_S3_BUCKET;
    process.env.LAKE_DIR = "/tmp/lake-backlog-test-unused";
    delete process.env.LAKE_BACKLOG_MAX_AGE_MINUTES;
    delete process.env.LAKE_BACKLOG_MAX_BATCHES;
  });

  afterEach(() => {
    for (const [key, value] of [["LAKE_DIR", saved.dir], ["LAKE_S3_BUCKET", saved.bucket]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  afterAll(async () => {
    await cleanDatabase();
    await prisma.$disconnect();
  });

  async function queue(tenantId: string, ageMinutes: number, count = 1) {
    const agent = await createTestAgent(tenantId);
    for (let i = 0; i < count; i++) {
      await enqueueLakeBatch(prisma, { tenantId, agentId: agent.id, events: [ev(i)], receivedAt: MINUTES_AGO(ageMinutes) });
    }
  }

  it("answers 503 while the lake is off", async () => {
    delete process.env.LAKE_DIR;
    expect((await GET(cronRequest())).status).toBe(503);
  });

  it("opens one case for a tenant whose oldest batch is too old, however many times it runs", async () => {
    const stuck = await createTestTenant();
    await queue(stuck.id, 30);

    const created: number[] = [];
    for (let run = 0; run < 3; run++) {
      const res = await GET(cronRequest());
      expect(res.status).toBe(200);
      created.push((await res.json()).casesCreated);
    }

    expect(created).toEqual([1, 0, 0]);
    const cases = await prisma.case.findMany({ where: { tenantId: stuck.id } });
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ title: "Telemetry lake backlog", severity: "high", status: "open" });
    expect(cases[0].description).toContain("30 min old");
  });

  it("opens a case when the queue is too long, and not for a healthy tenant", async () => {
    process.env.LAKE_BACKLOG_MAX_BATCHES = "2";
    const long = await createTestTenant();
    const healthy = await createTestTenant();
    await queue(long.id, 1, 3);
    await queue(healthy.id, 1, 2);

    const body = await (await GET(cronRequest())).json();

    expect(body).toMatchObject({ tenantsQueued: 2, breached: 1, casesCreated: 1 });
    expect(await prisma.case.count({ where: { tenantId: long.id } })).toBe(1);
    expect(await prisma.case.count({ where: { tenantId: healthy.id } })).toBe(0);
  });

  it("opens a new case once the previous one is closed and the queue is still stuck", async () => {
    const stuck = await createTestTenant();
    await queue(stuck.id, 30);
    await GET(cronRequest());
    await prisma.case.updateMany({ where: { tenantId: stuck.id }, data: { status: "closed" } });

    expect((await (await GET(cronRequest())).json()).casesCreated).toBe(1);
    expect(await prisma.case.count({ where: { tenantId: stuck.id } })).toBe(2);
  });

  it("opens nothing for an empty queue", async () => {
    await createTestTenant();
    expect((await (await GET(cronRequest())).json()).casesCreated).toBe(0);
  });
});
