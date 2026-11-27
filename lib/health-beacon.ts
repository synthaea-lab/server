import { z } from "zod";

/** More sensors than any platform loads; bounds what one beacon can store. */
const MAX_SENSORS = 64;
const MAX_NAME = 128;

/**
 * The largest counter a beacon stores. Counters are Postgres `BIGINT` (at most 2^63 − 1), and a
 * larger one would make the upsert throw and the whole beacon be dropped, loss stamp included.
 * 2^63 − 1024 is the largest double below 2^63, so it is the largest JSON number that fits.
 *
 * A counter above it saturates here rather than failing the parse: the beacon is still stored,
 * and an absurd loss counter still reads as rising loss. A rejected beacon would be dropped
 * without trace, since the heartbeat answers 200 whatever happens to its beacon.
 */
export const MAX_STORABLE_COUNTER = 2 ** 63 - 1024;

const counter = z
  .number()
  .int()
  .nonnegative()
  .finite()
  .transform((value) => Math.min(value, MAX_STORABLE_COUNTER));

/**
 * One serialized `schema::HealthBeacon` (what `transport` posts as
 * `{ agent_id, beacon }`). Counters are `u64` on the agent; JSON numbers hold
 * them exactly up to 2^53, far beyond any real spool or drop count.
 */
export const HealthBeacon = z.object({
  timestamp_ns: counter,
  agent_version: z.string().max(MAX_NAME),
  sensors: z
    .array(
      z.object({
        name: z.string().min(1).max(MAX_NAME),
        pulse_count: counter,
        silent: z.boolean(),
      })
    )
    .max(MAX_SENSORS),
  spool_bytes: counter,
  spool_dropped: counter,
  enrich_dropped: counter,
  // ADR-0020 / #76. Absent from an agent that predates them: counted as zero, so such an
  // agent's beacon is still stored.
  rarity_applied: counter.default(0),
  rarity_withheld: counter.default(0),
  rarity_unapplied: counter.default(0),
  // #863: watchdog restarts, tamper-class alerts, and what the Linux parent-image cache dropped.
  // Absent from an agent that predates them: counted as zero.
  watchdog_restarts: counter.default(0),
  tamper_events: counter.default(0),
  parent_image_evicted_live: counter.default(0),
  parent_image_evicted_dead: counter.default(0),
  // #60: the on-device IOC engine. `ioc_indicators` is a gauge. Absent from an agent that
  // predates them: counted as zero.
  ioc_indicators: counter.default(0),
  ioc_findings: counter.default(0),
  ioc_cooled_down: counter.default(0),
  // #1061: IOC matches skipped as the agent's own control-plane traffic, by the agent itself and
  // by a second process on its executable. Absent from an older agent: zero.
  ioc_own_skipped: counter.default(0),
  ioc_sibling_skipped: counter.default(0),
  // #91: alerts the agent could not write to `alerts.ndjson` (agent#167), and what the Windows ETW
  // sensor's caches shed (agent#314; zero on other platforms). Absent from an older agent: zero.
  alerts_dropped: counter.default(0),
  etw_pid_cache_evicted: counter.default(0),
  etw_silo_evicted: counter.default(0),
  etw_marks_dropped: counter.default(0),
  etw_quarantine_unremembered: counter.default(0),
});
export type HealthBeacon = z.infer<typeof HealthBeacon>;

/**
 * The beacon inside a heartbeat request body, or `null` when the body is not
 * one. A heartbeat without a usable beacon is still a heartbeat (liveness
 * matters more than telemetry), so callers ignore `null` rather than reject.
 */
export function parseHeartbeatBody(body: unknown): HealthBeacon | null {
  if (typeof body !== "object" || body === null) return null;
  const parsed = HealthBeacon.safeParse((body as Record<string, unknown>).beacon);
  return parsed.success ? parsed.data : null;
}

/** The agent's `timestamp_ns` as a Date (millisecond precision). */
export function beaconTime(beacon: HealthBeacon): Date {
  return new Date(Math.floor(beacon.timestamp_ns / 1_000_000));
}
