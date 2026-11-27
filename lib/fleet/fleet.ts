import type { AgentHealth, PrismaClient } from "@prisma/client";
import {
  fleetStatus,
  lostRecently,
  sensorsOf,
  type EtwShedding,
  type RingLoss,
  type FleetStatus,
  type SensorState,
} from "@/lib/fleet/health";

export type FleetAgent = {
  id: string;
  hostname: string | null;
  ring: string;
  version: string | null;
  lastSeen: string;
  status: FleetStatus;
  /** Only for an agent that has sent a beacon. */
  health: {
    beaconAt: string;
    agentVersion: string;
    spoolBytes: number;
    spoolDropped: number;
    enrichDropped: number;
    /** When a loss counter last rose between two beacons (server clock); null if never seen. */
    lossObservedAt: string | null;
    /** Within the window that makes the host `degraded` for telemetry loss. */
    recentLoss: boolean;
    /** Rarity evidence applied, withheld and lost since the agent started (ADR-0020). */
    rarityApplied: number;
    rarityWithheld: number;
    rarityUnapplied: number;
    /** Watchdog restarts of the agent since the watchdog started; 0 without a watchdog (#863). */
    watchdogRestarts: number;
    /** Tamper-class alerts since the agent started, plus the watchdog's own events. */
    tamperEvents: number;
    /** Parent-image cache entries dropped while their process was alive (the loss), and after it exited. */
    parentImageEvictedLive: number;
    parentImageEvictedDead: number;
    /** On-device IOC engine (#60): indicators in force (a gauge, 0 with no feed), findings raised, repeats held back by the cooldown. */
    iocIndicators: number;
    iocFindings: number;
    iocCooledDown: number;
    /** Alerts that could not be written to `alerts.ndjson` since the agent started (#91). */
    alertsDropped: number;
    /** What the Windows ETW sensor's caches shed since it started; zeros elsewhere (#91). */
    etwShedding: EtwShedding;
    /** What the Linux eBPF probes lost to a full ring since the agent started; zeros elsewhere (#95). */
    ringLoss: RingLoss;
    sensors: SensorState[];
  } | null;
};

/** The most agents one dashboard page lists. */
export const FLEET_PAGE_SIZE = 500;

/** A tenant's agents with their latest health, worst status first. */
export async function loadFleet(
  db: Pick<PrismaClient, "agent">,
  tenantId: string,
  now: Date = new Date()
): Promise<FleetAgent[]> {
  const rows = await db.agent.findMany({
    where: { tenantId },
    include: { health: true },
    orderBy: { lastSeen: "desc" },
    take: FLEET_PAGE_SIZE,
  });
  const order: Record<FleetStatus, number> = { silent: 0, degraded: 1, no_beacon: 2, healthy: 3 };
  return rows
    .map((a): FleetAgent => {
      const sensors = a.health ? sensorsOf(a.health.sensors) : [];
      return {
        id: a.id,
        hostname: a.hostname,
        ring: a.ring,
        version: a.version,
        lastSeen: a.lastSeen.toISOString(),
        status: fleetStatus(
          a,
          a.health ? { sensors, lossObservedAt: a.health.lossObservedAt } : null,
          now
        ),
        health: a.health && healthView(a.health, sensors, now),
      };
    })
    .sort((x, y) => order[x.status] - order[y.status]);
}

/** An agent's stored beacon as the fleet view shows it: counters as numbers, times as ISO strings. */
function healthView(health: AgentHealth, sensors: SensorState[], now: Date): NonNullable<FleetAgent["health"]> {
  return {
    beaconAt: health.beaconAt.toISOString(),
    agentVersion: health.agentVersion,
    spoolBytes: Number(health.spoolBytes),
    spoolDropped: Number(health.spoolDropped),
    enrichDropped: Number(health.enrichDropped),
    lossObservedAt: health.lossObservedAt?.toISOString() ?? null,
    recentLoss: lostRecently(health.lossObservedAt, now),
    rarityApplied: Number(health.rarityApplied),
    rarityWithheld: Number(health.rarityWithheld),
    rarityUnapplied: Number(health.rarityUnapplied),
    watchdogRestarts: Number(health.watchdogRestarts),
    tamperEvents: Number(health.tamperEvents),
    parentImageEvictedLive: Number(health.parentImageEvictedLive),
    parentImageEvictedDead: Number(health.parentImageEvictedDead),
    iocIndicators: Number(health.iocIndicators),
    iocFindings: Number(health.iocFindings),
    iocCooledDown: Number(health.iocCooledDown),
    alertsDropped: Number(health.alertsDropped),
    etwShedding: {
      pidCacheEvicted: Number(health.etwPidCacheEvicted),
      siloEvicted: Number(health.etwSiloEvicted),
      marksDropped: Number(health.etwMarksDropped),
      quarantineUnremembered: Number(health.etwQuarantineUnremembered),
    },
    ringLoss: {
      dropped: Number(health.ringDropped),
      execDropped: Number(health.execRingDropped),
    },
    sensors,
  };
}
