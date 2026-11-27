import { formatTime } from "@/lib/hunt/view";
import type { EventRow } from "@/lib/hunt/events-search";

/** The typed columns of archived events, one row each (a saved event hunt's matches and its runs' samples). */
export function EventTable({ rows }: { rows: EventRow[] }) {
  return (
    <table className="min-w-full text-sm">
      <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
        <tr>
          <th className="px-4 py-2">Time</th>
          <th className="px-4 py-2">Type</th>
          <th className="px-4 py-2">Host</th>
          <th className="px-4 py-2">Process</th>
          <th className="px-4 py-2">Path / address / query</th>
          <th className="px-4 py-2">SHA-256</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-100">
        {rows.map((row, i) => (
          <tr key={`${row.timestamp}-${i}`}>
            <td className="px-4 py-2 text-gray-600">{formatTime(new Date(row.timestamp))}</td>
            <td className="px-4 py-2 text-gray-900">{row.type}</td>
            <td className="px-4 py-2 font-mono text-xs text-gray-700">{row.agentId}</td>
            <td className="px-4 py-2 text-gray-700">{row.imagePath ?? row.comm ?? "–"}</td>
            <td className="px-4 py-2 text-gray-700 break-all">{row.path ?? row.daddr ?? row.query ?? "–"}</td>
            <td className="px-4 py-2 font-mono text-xs text-gray-700 break-all">{row.sha256 ?? "–"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
