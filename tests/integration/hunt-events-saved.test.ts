import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { cleanDatabase, createTestAgent, createTestTenant, prisma } from "../helpers/db";
import { createTenantHeaders } from "../helpers/http";
import { POST as createHunt } from "@/app/api/hunts/route";
import { GET as getHunt, PATCH as patchHunt } from "@/app/api/hunts/[id]/route";
import { POST as runHuntRoute } from "@/app/api/hunts/[id]/run/route";
import { GET as matchesRoute } from "@/app/api/hunts/[id]/matches/route";
import { POST as graduateHunt } from "@/app/api/hunts/[id]/graduate/route";
import { GET as runHuntsCron } from "@/app/api/cron/run-hunts/route";
import { FsLakeStore, type EventArchive } from "@/lib/lake-store";
import { parquetWriteBuffer } from "hyparquet-writer";
import { drainLakeQueue, enqueueLakeBatch, lakeKey } from "@/lib/lake-writer";
import { MAX_CONCURRENT_SEARCHES_PER_TENANT } from "@/lib/hunt-search";
import { runHunt } from "@/lib/hunt-runner";

const HOUR = 3_600_000;
const NOW = new Date(Date.UTC(2026, 10, 18, 12, 0, 0));
const eventsQuery = { kind: "events", version: 1, lastDays: 7, types: ["exec"], where: { imagePath: "/tmp/dropper" } };

let dir: string;
let store: FsLakeStore;
const ready = (): EventArchive => ({ state: "ready", reader: store });

beforeEach(async () => {
  await cleanDatabase();
  dir = await mkdtemp(path.join(os.tmpdir(), "hunt-events-saved-"));
  store = new FsLakeStore(dir);
});
afterEach(async () => {
  delete process.env.LAKE_DIR;
  delete process.env.LAKE_S3_BUCKET;
  await rm(dir, { recursive: true, force: true });
});
afterAll(async () => {
  await cleanDatabase();
  await prisma.$disconnect();
});

/** Uploads `n` events at `at` through the real queue and writer. */
async function upload(tenantId: string, agentId: string, at: Date, n: number, event: object = { type: "exec", image_path: "/tmp/dropper" }) {
  const events = Array.from({ length: n }, (_, i) => ({ ...event, meta: { comm: "bash", timestamp_ns: (at.getTime() + i) * 1_000_000 } }));
  await enqueueLakeBatch(prisma, { tenantId, agentId, events, receivedAt: at });
  await drainLakeQueue(prisma, store, { now: at });
}

/** Queues `n` events stamped `stamped` by the agent, received at `receivedAt`; nothing is written to the archive yet. */
async function enqueueStamped(tenantId: string, agentId: string, stamped: Date, receivedAt: Date, n = 1) {
  const events = Array.from({ length: n }, (_, i) => ({ type: "exec", image_path: "/tmp/dropper", meta: { comm: "bash", timestamp_ns: (stamped.getTime() + i) * 1_000_000 } }));
  await enqueueLakeBatch(prisma, { tenantId, agentId, events, receivedAt });
}
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);

const req = (url: string, tenantId: string, method = "GET", body?: unknown) =>
  new NextRequest(`http://localhost${url}`, { method, headers: createTenantHeaders(tenantId, "analyst-1"), body: body === undefined ? undefined : JSON.stringify(body) });
const ctx = (id: string) => ({ params: { id } });

async function create(tenantId: string, query: unknown = eventsQuery, extra: Record<string, unknown> = {}) {
  const res = await createHunt(req("/api/hunts", tenantId, "POST", { name: "events hunt", query, ...extra }));
  expect(res.status).toBe(201);
  return (await res.json()).hunt as { id: string; version: number; tenantId: string; query: unknown };
}

describe("saved hunts over the event archive: the query", () => {
  it("stores an events query and refuses one that mixes the two sources or names more than the archive holds", async () => {
    const tenant = await createTestTenant();
    const hunt = await create(tenant.id);
    expect(hunt.query).toEqual(eventsQuery);
    for (const bad of [
      { ...eventsQuery, lastHours: 24 },
      { ...eventsQuery, lastDays: 91 },
      { ...eventsQuery, where: { tenantId: "other" } },
      { ...eventsQuery, kind: "cases" },
    ]) {
      const res = await createHunt(req("/api/hunts", tenant.id, "POST", { name: "bad", query: bad }));
      expect(res.status).toBe(400);
    }
    // A detection query still needs no kind.
    const detections = await createHunt(req("/api/hunts", tenant.id, "POST", { name: "d", query: { version: 1, lastHours: 24 } }));
    expect(detections.status).toBe(201);
  });

  it("bumps the version when a PATCH changes the source, not when it resends the same events query in another key order", async () => {
    const tenant = await createTestTenant();
    const hunt = await create(tenant.id);
    const same = { where: { imagePath: "/tmp/dropper" }, types: ["exec"], lastDays: 7, version: 1, kind: "events" };
    await patchHunt(req(`/api/hunts/${hunt.id}`, tenant.id, "PATCH", { query: same }), ctx(hunt.id));
    expect((await prisma.hunt.findUniqueOrThrow({ where: { id: hunt.id } })).version).toBe(1);
    await patchHunt(req(`/api/hunts/${hunt.id}`, tenant.id, "PATCH", { query: { version: 1, lastHours: 24 } }), ctx(hunt.id));
    expect((await prisma.hunt.findUniqueOrThrow({ where: { id: hunt.id } })).version).toBe(2);
  });
});

describe("saved hunts over the event archive: runs", () => {
  it("counts the matching events of the tenant only, keeps a typed sample, and counts what is new since the previous run", async () => {
    const [tenant, other] = [await createTestTenant(), await createTestTenant()];
    const [agent, otherAgent] = [await createTestAgent(tenant.id), await createTestAgent(other.id)];
    const hunt = await create(tenant.id);
    await upload(tenant.id, agent.id, new Date(NOW.getTime() - 2 * HOUR), 3);
    await upload(tenant.id, agent.id, new Date(NOW.getTime() - 2 * HOUR), 2, { type: "exec", image_path: "/usr/bin/ls" }); // another image
    await upload(other.id, otherAgent.id, new Date(NOW.getTime() - 2 * HOUR), 5); // another tenant's
    const row = await prisma.hunt.findUniqueOrThrow({ where: { id: hunt.id } });

    const first = await runHunt(prisma, row, "manual", NOW, { archive: ready() });
    expect(first).toMatchObject({ error: null, matchCount: 3, newMatchCount: 3, truncated: false, incomplete: false, sampleDetectionIds: [] });
    const sample = first.sampleEvents as { type: string; agentId: string; imagePath: string }[];
    expect(sample).toHaveLength(3);
    expect(sample.every((e) => e.type === "exec" && e.agentId === agent.id && e.imagePath === "/tmp/dropper")).toBe(true);
    // Typed columns only: never the event's source text.
    expect(JSON.stringify(first.sampleEvents)).not.toContain("meta");
    expect(Object.keys(sample[0]).sort()).toEqual(["agentId", "comm", "daddr", "imagePath", "path", "query", "sha256", "timestamp", "type"]);

    await upload(tenant.id, agent.id, new Date(NOW.getTime() + HOUR / 2), 2);
    const second = await runHunt(prisma, row, "schedule", new Date(NOW.getTime() + HOUR), { archive: ready() });
    expect(second).toMatchObject({ error: null, matchCount: 5, newMatchCount: 2, trigger: "schedule" });
  });

  it("counts an event as new when it reaches the archive after the run, not when the agent stamped it (late drain)", async () => {
    // The archive is written by a drain every few minutes: an event stamped just before run 1, queued
    // before it, and written after it is invisible to run 1 and must be new at run 2. Counting on the
    // agent's stamp said 0.
    const tenant = await createTestTenant();
    const agent = await createTestAgent(tenant.id);
    const row = await prisma.hunt.findUniqueOrThrow({ where: { id: (await create(tenant.id)).id } });
    await enqueueStamped(tenant.id, agent.id, minutes(-1), minutes(-0.5));

    const run1 = await runHunt(prisma, row, "schedule", NOW, { archive: ready() });
    expect(run1).toMatchObject({ error: null, matchCount: 0, newMatchCount: 0 });
    await drainLakeQueue(prisma, store, { now: minutes(3) });
    const run2 = await runHunt(prisma, row, "schedule", minutes(5), { archive: ready() });
    expect(run2).toMatchObject({ error: null, matchCount: 1, newMatchCount: 1 });
    const run3 = await runHunt(prisma, row, "schedule", minutes(10), { archive: ready() });
    expect(run3).toMatchObject({ error: null, matchCount: 1, newMatchCount: 0 });
  });

  it("counts an event stamped later than now as new once, not on every run", async () => {
    // An agent stamp up to a day ahead is accepted and lands in today's partition: counted by its own
    // stamp it was new on every run until the clock passed it, one notification per run.
    const tenant = await createTestTenant();
    const agent = await createTestAgent(tenant.id);
    const row = await prisma.hunt.findUniqueOrThrow({ where: { id: (await create(tenant.id)).id } });
    await runHunt(prisma, row, "schedule", minutes(-5), { archive: ready() });
    await enqueueStamped(tenant.id, agent.id, new Date(NOW.getTime() + 6 * HOUR), NOW);
    await drainLakeQueue(prisma, store, { now: NOW });

    const counts: number[] = [];
    for (const at of [5, 10, 15]) counts.push((await runHunt(prisma, row, "schedule", minutes(at), { archive: ready() })).newMatchCount);
    expect(counts).toEqual([1, 0, 0]);
  });

  it("reads a file written before the archive kept a write time, counting its events by their own stamp", async () => {
    const tenant = await createTestTenant();
    const agent = await createTestAgent(tenant.id);
    const row = await prisma.hunt.findUniqueOrThrow({ where: { id: (await create(tenant.id)).id } });
    const stamped = new Date(NOW.getTime() - 2 * HOUR);
    const legacy = parquetWriteBuffer({
      columnData: [
        { name: "agent_id", data: [agent.id], type: "STRING" },
        { name: "ts", data: [stamped], type: "TIMESTAMP" },
        { name: "comm", data: ["bash"], type: "STRING" },
        { name: "path", data: [null], type: "STRING" },
        { name: "image_path", data: ["/tmp/dropper"], type: "STRING" },
        { name: "daddr", data: [null], type: "STRING" },
        { name: "query", data: [null], type: "STRING" },
        { name: "sha256", data: [null], type: "STRING" },
        { name: "event", data: ["{}"], type: "STRING" },
      ],
    });
    await store.put(lakeKey(tenant.id, "2026-11-18", "exec", "legacy"), new Uint8Array(legacy));

    const first = await runHunt(prisma, row, "manual", NOW, { archive: ready() });
    expect(first).toMatchObject({ error: null, matchCount: 1, newMatchCount: 1 });
    const second = await runHunt(prisma, row, "manual", minutes(5), { archive: ready() });
    expect(second).toMatchObject({ error: null, matchCount: 1, newMatchCount: 0 });
  });

  it("leaves the event samples out of the history and keeps them on the run", async () => {
    // Each run's sample is up to 50 rows: the history lists up to 100 runs.
    const tenant = await createTestTenant();
    const agent = await createTestAgent(tenant.id);
    const hunt = await create(tenant.id);
    await upload(tenant.id, agent.id, new Date(NOW.getTime() - HOUR), 2);
    const run = await runHunt(prisma, await prisma.hunt.findUniqueOrThrow({ where: { id: hunt.id } }), "manual", NOW, { archive: ready() });
    expect(run.sampleEvents).toHaveLength(2);

    const history = (await (await getHunt(req(`/api/hunts/${hunt.id}`, tenant.id), ctx(hunt.id))).json()).runs;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ matchCount: 2, newMatchCount: 2, trigger: "manual" });
    expect(history[0]).not.toHaveProperty("sampleEvents");
  });

  it("records a failed run, not a throw, when the archive is off or has no reader", async () => {
    const tenant = await createTestTenant();
    const row = await prisma.hunt.findUniqueOrThrow({ where: { id: (await create(tenant.id)).id } });
    const off = await runHunt(prisma, row, "manual", NOW, { archive: { state: "off" } });
    expect(off.error).toMatch(/archive is off/);
    expect(off).toMatchObject({ matchCount: 0, finishedAt: expect.any(Date) });
    const noReader = await runHunt(prisma, row, "manual", NOW, { archive: { state: "no_reader" } });
    expect(noReader.error).toMatch(/no reader/);
  });

  it("records a failed run when the tenant's search slots are taken, and frees them for the next run", async () => {
    const tenant = await createTestTenant();
    const row = await prisma.hunt.findUniqueOrThrow({ where: { id: (await create(tenant.id)).id } });
    // Take every slot: one transaction per slot, held while the run asks.
    const held = Array.from({ length: MAX_CONCURRENT_SEARCHES_PER_TENANT }, (_, slot) =>
      prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`hunt_search:${tenant.id}:${slot}`}))`);
          await tx.$executeRaw(Prisma.sql`SELECT pg_sleep(1.5)`);
        },
        { timeout: 10_000 }
      )
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    const busy = await runHunt(prisma, row, "manual", NOW, { archive: ready() });
    expect(busy.error).toMatch(/searches in flight/);
    await Promise.all(held);
    expect((await runHunt(prisma, row, "manual", NOW, { archive: ready() })).error).toBeNull();
  });

  it("cancels a read over its time limit and records it as failed", async () => {
    const tenant = await createTestTenant();
    const row = await prisma.hunt.findUniqueOrThrow({ where: { id: (await create(tenant.id)).id } });
    const slowReader = {
      list: async (...a: Parameters<FsLakeStore["list"]>) => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return store.list(...a);
      },
      get: (...a: Parameters<FsLakeStore["get"]>) => store.get(...a),
    };
    const run = await runHunt(prisma, row, "manual", NOW, { archive: { state: "ready", reader: slowReader }, eventTimeoutMs: 100 });
    expect(run.error).toBe("the search exceeded its time limit and was cancelled");
    expect(run.finishedAt).not.toBeNull();
  });

  it("marks a count that hit its ceiling as truncated", async () => {
    const tenant = await createTestTenant();
    const agent = await createTestAgent(tenant.id);
    const row = await prisma.hunt.findUniqueOrThrow({ where: { id: (await create(tenant.id)).id } });
    await upload(tenant.id, agent.id, new Date(NOW.getTime() - HOUR), 1001);
    const run = await runHunt(prisma, row, "manual", NOW, { archive: ready() });
    expect(run).toMatchObject({ matchCount: 1000, truncated: true });
    expect(run.sampleEvents as unknown[]).toHaveLength(50);
  });
});

describe("saved hunts over the event archive: routes and schedule", () => {
  it("runs through the route and the cron against the archive from the environment, and lists the run in the history", async () => {
    const tenant = await createTestTenant();
    const agent = await createTestAgent(tenant.id);
    const hunt = await create(tenant.id, { ...eventsQuery, lastDays: 90 }, { scheduleMinutes: 5 });
    await upload(tenant.id, agent.id, new Date(Date.now() - HOUR), 4);
    process.env.LAKE_DIR = dir;

    const manual = await (await runHuntRoute(req(`/api/hunts/${hunt.id}/run`, tenant.id, "POST"), ctx(hunt.id))).json();
    expect(manual.run).toMatchObject({ error: null, matchCount: 4, trigger: "manual" });
    await prisma.huntRun.updateMany({ where: { huntId: hunt.id }, data: { startedAt: new Date(Date.now() - 10 * 60_000) } });
    const cron = await (await runHuntsCron(new NextRequest("http://localhost/api/cron/run-hunts", { headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` } }))).json();
    expect(cron).toMatchObject({ ran: 1, failed: 0 });
    const history = (await (await getHunt(req(`/api/hunts/${hunt.id}`, tenant.id), ctx(hunt.id))).json()).runs;
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ trigger: "schedule", matchCount: 4, newMatchCount: 0 });
  });

  it("answers the matches route with the newest events, 503 while the archive is off, and 404 for another tenant", async () => {
    const [tenant, other] = [await createTestTenant(), await createTestTenant()];
    const agent = await createTestAgent(tenant.id);
    const hunt = await create(tenant.id);
    await upload(tenant.id, agent.id, new Date(Date.now() - HOUR), 2);
    process.env.LAKE_DIR = dir;

    const ok = await matchesRoute(req(`/api/hunts/${hunt.id}/matches`, tenant.id), ctx(hunt.id));
    expect(ok.status).toBe(200);
    const page = await ok.json();
    expect(page).toMatchObject({ source: "events", truncated: false });
    expect(page.rows).toHaveLength(2);
    expect((await matchesRoute(req(`/api/hunts/${hunt.id}/matches`, other.id), ctx(hunt.id))).status).toBe(404);
    delete process.env.LAKE_DIR;
    expect((await matchesRoute(req(`/api/hunts/${hunt.id}/matches`, tenant.id), ctx(hunt.id))).status).toBe(503);
  });

  it("refuses to graduate a hunt over the archive", async () => {
    const tenant = await createTestTenant();
    const agent = await createTestAgent(tenant.id);
    const hunt = await create(tenant.id);
    await upload(tenant.id, agent.id, new Date(Date.now() - HOUR), 1);
    process.env.LAKE_DIR = dir;
    await runHuntRoute(req(`/api/hunts/${hunt.id}/run`, tenant.id, "POST"), ctx(hunt.id));
    const res = await graduateHunt(req(`/api/hunts/${hunt.id}/graduate`, tenant.id, "POST", { platform: "linux" }), ctx(hunt.id));
    expect(res.status).toBe(422);
    expect((await res.json()).problems).toEqual(["event hunt"]);
  });
});
