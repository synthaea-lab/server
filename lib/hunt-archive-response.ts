import { NextResponse } from "next/server";

/**
 * The answer of an API route when a read of the event archive could not start: 503 while the lake is
 * off, 501 when it is on but its store has no reader (#1105). 503 says "try later" and an operator's
 * monitoring reads it as an outage, whereas 501 stays true until the store gets a reader. Shared by the search and by a saved hunt's matches.
 */
export function isArchiveUnavailable(outcome: { status: string }): outcome is { status: "lake_off" | "no_reader" } {
  return outcome.status === "lake_off" || outcome.status === "no_reader";
}

export function archiveUnavailableResponse(outcome: { status: "lake_off" | "no_reader" }): NextResponse {
  if (outcome.status === "lake_off") {
    return NextResponse.json({ error: "The event archive is not available (the telemetry lake is off)" }, { status: 503 });
  }
  return NextResponse.json(
    { error: "The event archive cannot be searched: the telemetry lake is on but its store has no reader" },
    { status: 501 }
  );
}
