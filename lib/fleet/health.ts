/** Matches the silent-agent cron: no heartbeat for this long means silent. */
export const SILENCE_THRESHOLD_MS = 5 * 60 * 1000;

/** How long after a loss counter last rose a host still counts as degraded for it (#83). */
export const LOSS_WINDOW_MS = 10 * 60 * 1000;

export type FleetStatus = "silent" | "degraded" | "healthy" | "no_beacon";

export type SensorState = { name: string; pulse_count: number; silent: boolean };

/**
 * One agent's place on the dashboard, worst first: `silent` (no heartbeat),
 * `degraded` (heartbeating, but a sensor reports silent, or it lost telemetry within
 * [`LOSS_WINDOW_MS`]: see [`nextLossObservedAt`]), `no_beacon` (alive, but never sent
 * health: an older agent, or one whose beacons are rejected), else `healthy`. A silent
 * agent's last beacon is stale, so its sensors are not reported as the reason.
 */
export function fleetStatus(
  agent: { lastSeen: Date },
  health: { sensors: SensorState[]; lossObservedAt?: Date | null } | null,
  now: Date
): FleetStatus {
  if (now.getTime() - agent.lastSeen.getTime() > SILENCE_THRESHOLD_MS) return "silent";
  if (!health) return "no_beacon";
  return health.sensors.some((s) => s.silent) || lostRecently(health.lossObservedAt, now)
    ? "degraded"
    : "healthy";
}

/** Whether `lossObservedAt` is within [`LOSS_WINDOW_MS`] of `now`. */
export function lostRecently(lossObservedAt: Date | null | undefined, now: Date): boolean {
  return !!lossObservedAt && now.getTime() - lossObservedAt.getTime() < LOSS_WINDOW_MS;
}

/**
 * The on-device IOC engine (#60) as one line for the console. `indicators` is a gauge, `0` while no
 * feed is loaded and for an agent that predates the counters, so the two read alike ("no feed"):
 * what the server can tell is a host with no feed from one with a feed and no match. `findings` and
 * `cooledDown` are cumulative since the agent started; a repeat of an indicator inside the cooldown
 * is counted in `cooledDown` and raised no second finding.
 */
export function iocFeedSummary(ioc: { iocIndicators: number; iocFindings: number; iocCooledDown: number }): string {
  if (ioc.iocIndicators === 0) return "no feed";
  const base = `${ioc.iocIndicators} indicators, ${ioc.iocFindings} findings`;
  return ioc.iocCooledDown > 0 ? `${base}, ${ioc.iocCooledDown} repeats held back` : base;
}

/** The Windows ETW sensor's cache counters, as the beacon names them (agent#314). */
export type EtwShedding = {
  /** Pid-cache entries evicted at the cap: a later event of that process misses its image. */
  pidCacheEvicted: number;
  /** Silo-directory entries evicted at the cap: the container is looked up again. */
  siloEvicted: number;
  /** `Zone.Identifier` marks dropped from the read-back queue: each is a lost `FileQuarantine`. */
  marksDropped: number;
  /** Quarantine paths reported without dedup (map full): a possible duplicate, never a loss. */
  quarantineUnremembered: number;
};

/**
 * The ETW caches' shedding in one cell: "none" when nothing was shed (every non-Windows host), else
 * only the counters that moved. Lost quarantine marks come first: they are the one real loss.
 */
export function etwSheddingSummary(shed: EtwShedding): string {
  const parts = [
    [shed.marksDropped, "quarantine marks lost"],
    [shed.pidCacheEvicted, "pid-cache evictions"],
    [shed.siloEvicted, "silo evictions"],
    [shed.quarantineUnremembered, "quarantines not deduplicated"],
  ] as const;
  const moved = parts.filter(([count]) => count > 0).map(([count, what]) => `${count} ${what}`);
  return moved.length === 0 ? "none" : moved.join(", ");
}

/** What the Linux eBPF probes lost to a full ring buffer (agent#336). */
export type RingLoss = {
  /** Events lost, summed over every ring. */
  dropped: number;
  /** The part of `dropped` lost from the exec ring: process starts the rules never saw. */
  execDropped: number;
};

/** The ring loss in one cell: "none" (every non-Linux host too), else the total, exec part first. */
export function ringLossSummary(loss: RingLoss): string {
  if (loss.dropped === 0) return "none";
  return loss.execDropped > 0 ? `${loss.dropped} (${loss.execDropped} process starts)` : `${loss.dropped}`;
}

/** What `agent_health` holds about an agent's last beacon, as far as loss detection reads it. */
export type StoredLoss = {
  beaconAt: Date;
  spoolDropped: bigint;
  enrichDropped: bigint;
  etwMarksDropped: bigint;
  ringDropped: bigint;
  lossObservedAt: Date | null;
};

/** A beacon's loss counters, by the name the agent sends them under. */
type BeaconLoss = {
  spool_dropped: number;
  enrich_dropped: number;
  etw_marks_dropped: number;
  ring_dropped: number;
};

/**
 * Each counter that counts telemetry which never reaches the server, paired with the column it is
 * stored in. A lost quarantine mark is a `FileQuarantine` event that is never sent (agent#314); a
 * ring drop is an event the eBPF probes never delivered (agent#336). `exec_ring_dropped` is part of
 * `ring_dropped`, so it never rises alone and needs no entry of its own.
 */
const LOSS_COUNTERS = [
  ["spool_dropped", "spoolDropped"],
  ["enrich_dropped", "enrichDropped"],
  ["etw_marks_dropped", "etwMarksDropped"],
  ["ring_dropped", "ringDropped"],
] as const satisfies ReadonlyArray<readonly [keyof BeaconLoss, keyof StoredLoss]>;

/**
 * The loss stamp after a beacon arrives (#83). The agent's loss counters ([`LOSS_COUNTERS`]) are
 * cumulative since it started and the server keeps only the latest beacon,
 * so a recent loss is told by a counter *rising* between two beacons, stamped with the server's
 * receive time (not the agent's clock, which can be skewed).
 *
 * - The first beacon of an agent is never loss: it has nothing to compare with, and a row
 *   missing for another reason (a reset database) must not flag a healthy host.
 * - A counter that fell is an agent restart, not loss, and neither sets nor clears the stamp.
 * - A beacon older than the stored one is `stale`: the caller must not store it, or its lower
 *   counters would make the next real beacon look like a rise.
 * - Only the loss counters count. The rarity evidence counters are information about a feature,
 *   `alerts_dropped` counts alerts that still reached stderr and `cli detections`, and the other
 *   ETW counters degrade enrichment: none of them is telemetry the server never receives.
 */
export function nextLossObservedAt(
  previous: StoredLoss | null,
  beacon: BeaconLoss & { timestamp_ns: number },
  receivedAt: Date
): { stale: boolean; lossObservedAt: Date | null } {
  if (!previous) return { stale: false, lossObservedAt: null };
  if (Math.floor(beacon.timestamp_ns / 1_000_000) < previous.beaconAt.getTime()) {
    return { stale: true, lossObservedAt: previous.lossObservedAt };
  }
  const rose = LOSS_COUNTERS.some(([sent, stored]) => BigInt(beacon[sent]) > previous[stored]);
  return { stale: false, lossObservedAt: rose ? receivedAt : previous.lossObservedAt };
}

/** Sensors from stored JSON, tolerating a row written by a different version. */
export function sensorsOf(json: unknown): SensorState[] {
  if (!Array.isArray(json)) return [];
  return json.flatMap((s) =>
    s && typeof s.name === "string" && typeof s.silent === "boolean"
      ? [{ name: s.name, pulse_count: Number(s.pulse_count) || 0, silent: s.silent }]
      : []
  );
}
