import { prisma } from "@/lib/prisma";
import { requireConsoleTenant } from "@/lib/console-session";
import { NoOrganization } from "@/components/NoOrganization";
import { HUNT_RUN_HISTORY_SELECT, HUNT_RUNS_KEPT } from "@/lib/hunt";
import {
  describeQuery,
  describeSchedule,
  formatDuration,
  formatTime,
  ownerLabel,
  runState,
  STATE_LABEL,
  STATE_STYLE,
} from "@/lib/hunt-view";
import { RunHuntButton } from "@/components/RunHuntButton";
import { GraduateHuntButton } from "@/components/GraduateHuntButton";
import { EventTable } from "@/components/EventTable";
import { isEventQuery, parseSavedHuntQuery } from "@/lib/hunt-input";
import type { EventRow } from "@/lib/hunt-events-search";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function HuntPage({ params }: { params: { id: string } }) {
  const caller = await requireConsoleTenant();
  if ("noOrganization" in caller) return <NoOrganization />;
  const { tenantId, userId } = caller;

  // Scoped to the session's tenant: another tenant's hunt is a 404, never its contents.
  const hunt = await prisma.hunt.findFirst({ where: { id: params.id, tenantId } });
  if (!hunt) notFound();
  const runs = await prisma.huntRun.findMany({
    where: { huntId: hunt.id, tenantId },
    orderBy: { startedAt: "desc" },
    take: HUNT_RUNS_KEPT,
    // The table shows counts only; the one sample the page shows is read below.
    select: HUNT_RUN_HISTORY_SELECT,
  });
  const now = new Date();
  const isEventHunt = (() => {
    try {
      return isEventQuery(parseSavedHuntQuery(hunt.query));
    } catch {
      return false;
    }
  })();
  // An event hunt's latest run keeps the events it sampled; show them here, so the page says what the run saw.
  // Only the latest run: when it failed there is nothing to show, not an older run's events under a newer label.
  const latest = runs[0];
  const sampled = isEventHunt && latest && latest.finishedAt && !latest.error ? latest : undefined;
  const sampledRow = sampled ? await prisma.huntRun.findFirst({ where: { id: sampled.id, tenantId }, select: { sampleEvents: true } }) : null;
  const sampleEvents = sampledRow && Array.isArray(sampledRow.sampleEvents) ? (sampledRow.sampleEvents as unknown as EventRow[]) : [];

  return (
    <div>
      <a href="/console/hunts" className="text-sm text-indigo-700 hover:underline">
        ← Hunts
      </a>
      <div className="mt-2 mb-6 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">{hunt.name}</h2>
          {hunt.description && <p className="mt-1 text-sm text-gray-600">{hunt.description}</p>}
        </div>
        <div className="flex shrink-0 items-start gap-3">
          <a
            href={`/console/hunts/${hunt.id}/matches`}
            className="px-3 py-1.5 text-sm font-medium rounded-md border border-gray-300 text-gray-700 hover:bg-gray-50"
          >
            Matches
          </a>
          <a
            href={`/console/hunts/${hunt.id}/edit`}
            className="px-3 py-1.5 text-sm font-medium rounded-md border border-gray-300 text-gray-700 hover:bg-gray-50"
          >
            Edit
          </a>
          <RunHuntButton huntId={hunt.id} />
        </div>
      </div>

      <dl className="mb-6 grid grid-cols-1 gap-4 rounded-lg border border-gray-200 bg-white p-4 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs uppercase text-gray-500">Query (version {hunt.version})</dt>
          <dd className="mt-1 text-gray-900">{describeQuery(hunt.query)}</dd>
          <dd className="mt-1">
            <pre className="overflow-x-auto rounded bg-gray-50 p-2 text-xs text-gray-700">
              {JSON.stringify(hunt.query, null, 2)}
            </pre>
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase text-gray-500">Schedule</dt>
          <dd className="mt-1 text-gray-900">{describeSchedule(hunt.scheduleMinutes, hunt.active)}</dd>
          <dt className="mt-3 text-xs uppercase text-gray-500">Created</dt>
          <dd className="mt-1 text-gray-900">
            {formatTime(hunt.createdAt)} by <span title={hunt.ownerId}>{ownerLabel(hunt.ownerId, userId)}</span>
          </dd>
        </div>
      </dl>

      {isEventHunt ? (
        <p className="mb-6 text-xs text-gray-500">A hunt over the event archive cannot be graduated: rule and IOC drafts are made from detections.</p>
      ) : (
        <GraduateHuntButton huntId={hunt.id} />
      )}

      <h3 className="mb-2 text-lg font-semibold text-gray-900">History</h3>
      {runs.length === 0 ? (
        <p className="text-sm text-gray-600">This hunt has not run yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
              <tr>
                <th className="px-4 py-2">Started</th>
                <th className="px-4 py-2">Result</th>
                <th className="px-4 py-2">Trigger</th>
                <th className="px-4 py-2">Query</th>
                <th className="px-4 py-2">Took</th>
                <th className="px-4 py-2 text-right">Matches</th>
                <th className="px-4 py-2 text-right">New</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {runs.map((run) => {
                const state = runState(run, now);
                return (
                  <tr key={run.id}>
                    <td className="px-4 py-2 text-gray-700">{formatTime(run.startedAt)}</td>
                    <td className="px-4 py-2">
                      <span className={`rounded border px-2 py-0.5 text-xs ${STATE_STYLE[state]}`}>
                        {STATE_LABEL[state]}
                      </span>
                      {run.error && <span className="ml-2 text-red-700">{run.error}</span>}
                    </td>
                    <td className="px-4 py-2 text-gray-700">{run.trigger}</td>
                    <td className="px-4 py-2 text-gray-700">v{run.queryVersion}</td>
                    <td className="px-4 py-2 text-gray-700">{formatDuration(run) ?? "–"}</td>
                    <td className="px-4 py-2 text-right text-gray-900" title={run.incomplete ? "The oldest days were not read" : undefined}>
                      {state === "ok" ? `${run.matchCount}${run.truncated ? "+" : ""}${run.incomplete ? " *" : ""}` : "–"}
                    </td>
                    <td className="px-4 py-2 text-right text-gray-900">{state === "ok" ? run.newMatchCount : "–"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {sampleEvents.length > 0 && (
        <div className="mt-6">
          <h3 className="mb-2 text-lg font-semibold text-gray-900">Events of the latest run</h3>
          <p className="mb-2 text-xs text-gray-500">
            Run started {formatTime(sampled!.startedAt)}, query v{sampled!.queryVersion}.
            The newest {sampleEvents.length} of {sampled?.matchCount}{sampled?.truncated ? "+" : ""} events, typed columns only.
            A count with + is a floor (a run counts up to 1000); * means the archive had more files than one run reads, so the oldest days were not read.
            New counts events written to the archive after the previous run started.
          </p>
          <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white"><EventTable rows={sampleEvents} /></div>
        </div>
      )}
      <p className="mt-3 text-xs text-gray-500">
        The newest {HUNT_RUNS_KEPT} runs are kept. A run that never finished (the server stopped
        while it ran) stays in the list as &quot;Did not finish&quot;.
      </p>
    </div>
  );
}
