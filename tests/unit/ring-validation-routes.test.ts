import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// Route logic runs against a mocked Prisma client, so these need no database.
const db = vi.hoisted(() => {
  const client = {
    agent: { findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn(), update: vi.fn() },
    contentRelease: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    binaryRelease: { findFirst: vi.fn(), create: vi.fn() },
    detection: { count: vi.fn() },
    auditLog: { create: vi.fn() },
    member: { findFirst: vi.fn() },
  };
  const tx = { ...client, $executeRaw: async () => 0 };
  return { ...tx, $transaction: async <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx) };
});
vi.mock("@/lib/prisma", () => ({ prisma: db }));

import { POST as assignRing } from "@/app/api/agents/[agentId]/ring/route";
import { POST as haltContent } from "@/app/api/content/halt/route";
import { POST as releaseContent } from "@/app/api/content/release/route";
import { POST as rollbackContent } from "@/app/api/content/rollback/route";
import { POST as releaseBinary } from "@/app/api/release/route";
import { GET as getContentManifest } from "@/app/api/content/manifest/[ring]/route";
import { GET as listRingAgents } from "@/app/api/rings/[ring]/agents/route";
import { GET as getRingHealth } from "@/app/api/rings/[ring]/health/route";
import { ContentManifest } from "@/lib/content/manifest";
import { keyRotationFile } from "@/lib/content/key-rotation";
import { RINGS } from "@/lib/content/rings";

const UNKNOWN_RING = "canary_9";
const SECRET = "test-proxy-secret";
const ADMIN_HEADERS = { "x-tenant-id": "t1", "x-user-id": "u1", "content-type": "application/json" };
const AGENT_HEADERS = {
  "X-Client-Cert-Verified": "SUCCESS",
  "X-Client-Cert-Subject": "CN=agent-1,O=synthaea",
  "X-Proxy-Secret": SECRET,
};

function adminPost(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: ADMIN_HEADERS,
    body: JSON.stringify(body),
  });
}

function get(path: string, headers: Record<string, string>): NextRequest {
  return new NextRequest(`http://localhost${path}`, { headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NGINX_PROXY_SECRET = SECRET;
  db.member.findFirst.mockResolvedValue({ role: "owner" });
  db.agent.findUnique.mockResolvedValue({ id: "a1", tenantId: "t1", ring: UNKNOWN_RING });
});

const RING_BODY_ROUTES: Array<[string, (ring: string) => Promise<NextResponse>]> = [
  ["POST /api/agents/{agentId}/ring", (ring) => assignRing(adminPost("/api/agents/a1/ring", { ring }), { params: { agentId: "a1" } })],
  ["POST /api/content/halt", (ring) => haltContent(adminPost("/api/content/halt", { ring }))],
  [
    "POST /api/content/release",
    (ring) =>
      releaseContent(
        adminPost("/api/content/release", { ring, manifestUrl: "storage://manifests/m.json", manifestSha256: "a".repeat(64) })
      ),
  ],
  ["POST /api/content/rollback", (ring) => rollbackContent(adminPost("/api/content/rollback", { ring }))],
  [
    "POST /api/release",
    (ring) =>
      releaseBinary(
        adminPost("/api/release", { ring, releaseVersion: 1, manifestUrl: "storage://manifests/m.json", manifestSha256: "a".repeat(64) })
      ),
  ],
];

describe("every route that takes a ring in its body refuses one outside the ring domain (#48)", () => {
  it.each(RING_BODY_ROUTES)("%s answers 400 and changes nothing", async (_route, call) => {
    const res = await call(UNKNOWN_RING);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid request");
    expect(db.agent.update).not.toHaveBeenCalled();
    expect(db.contentRelease.create).not.toHaveBeenCalled();
    expect(db.contentRelease.update).not.toHaveBeenCalled();
    expect(db.binaryRelease.create).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });
});

const RING_PATH_ROUTES: Array<[string, (ring: string) => Promise<NextResponse>]> = [
  [
    "GET /api/content/manifest/{ring}",
    (ring) => getContentManifest(get(`/api/content/manifest/${ring}`, AGENT_HEADERS), { params: { ring } }),
  ],
  ["GET /api/rings/{ring}/agents", (ring) => listRingAgents(get(`/api/rings/${ring}/agents`, ADMIN_HEADERS), { params: { ring } })],
  ["GET /api/rings/{ring}/health", (ring) => getRingHealth(get(`/api/rings/${ring}/health`, ADMIN_HEADERS), { params: { ring } })],
];

describe("every route that takes a ring in its path refuses one outside the ring domain (#48)", () => {
  it.each(RING_PATH_ROUTES)("%s answers 400 and names the valid rings", async (_route, call) => {
    const res = await call(UNKNOWN_RING);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid ring", validRings: [...RINGS] });
    expect(db.agent.count).not.toHaveBeenCalled();
    expect(db.agent.findMany).not.toHaveBeenCalled();
    expect(db.contentRelease.findFirst).not.toHaveBeenCalled();
  });
});

describe("the content manifest and key rotation accept exactly the ring domain (#48)", () => {
  it.each(RINGS)("names a key-rotation file for %s", (ring) => {
    expect(keyRotationFile(ring)).toMatch(new RegExp(`${ring}\\.json$`));
  });

  it("names no key-rotation file for a ring outside the domain", () => {
    expect(keyRotationFile(UNKNOWN_RING)).toBeNull();
  });

  it("refuses a content manifest for a ring outside the domain", () => {
    const manifest = {
      schema_version: 1,
      release_version: 1,
      ring: UNKNOWN_RING,
      released_at: "2026-10-12T09:30:00Z",
      entries: [{ path: "rules/a.sigma", type: "rule", sha256: "a".repeat(64), size: 1 }],
      signature: "00",
    };
    expect(ContentManifest.safeParse(manifest).success).toBe(false);
    expect(ContentManifest.safeParse({ ...manifest, ring: "canary_0" }).success).toBe(true);
  });
});
