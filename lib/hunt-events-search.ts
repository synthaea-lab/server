import type { Prisma, PrismaClient } from "@prisma/client";
import { HUNT_STATEMENT_TIMEOUT_MS, HUNT_TRANSACTION_TIMEOUT_MS } from "@/lib/hunt";
import { eventWindow, type EventQuery } from "@/lib/hunt-events";
import { SEARCH_PAGE_SIZE, admitSearch } from "@/lib/hunt-search";
import { MAX_ROWS, queryLake, type LakeRow } from "@/lib/lake-query";
import type { EventArchive } from "@/lib/lake-store";

/**
 * Ad-hoc search over the raw event archive (#933, ADR-0025 point 10): the third source of the hunt
 * search, read through `queryLake` (ADR-0041). Read-only, one page, newest first.
 *
 * The same bounds as the Postgres sources, in the form this source can take:
 * - **Time.** A search runs under `HUNT_STATEMENT_TIMEOUT_MS`. There is no SQL statement to cancel,
 *   so the deadline is an `AbortSignal` that `queryLake` checks before every file and that the
 *   readers pass on to the store, so a read in flight is abandoned too (a directory read may still
 *   finish). Past the deadline it throws the signal's `TimeoutError`, which `searchFailure` maps to a
 *   504: the readers rethrow the signal's reason, not the SDK's `AbortError`, which would be a 500.
 * - **In flight.** It takes one of the tenant's two slots (`admitSearch`), the same slots as a
 *   detection or case search, held for the whole read (the advisory lock lives in the transaction
 *   that wraps it). `busy` is a 429.
 * - **Rows.** A page is at most `SEARCH_PAGE_SIZE` rows, and a row carries the typed columns only,
 *   each cut to `FIELD_MAX`: never the event's source text (`includeEvent: false`, so the column is
 *   not even read), which is where a command line or an argument list lives.
 *
 * **Tenant isolation is structural.** `tenantId` is the caller's, from the session; the request has
 * no field for it, and `queryLake` lists only `tenant=<id>/` and rechecks every key it gets back.
 */

/** Longest value of a text field in a row. */
export const FIELD_MAX = 256;

export type EventRow = {
  type: string;
  /** ISO time of the event. */
  timestamp: string;
  agentId: string;
  comm: string | null;
  path: string | null;
  imagePath: string | null;
  daddr: string | null;
  query: string | null;
  sha256: string | null;
};

export type EventPage = {
  source: "events";
  rows: EventRow[];
  /** More events matched than the page holds; the page is the newest ones. There is no next page: narrow the window or filter. */
  truncated: boolean;
  /** The archive had more matching files than one search reads, so the oldest days were not read and the answer is incomplete. */
  incomplete: boolean;
  /** The days searched, `YYYY-MM-DD`, both included. */
  from: string;
  to: string;
};

export type EventSearchOutcome = { status: "ok"; page: EventPage } | { status: "busy" } | { status: "lake_off" } | { status: "no_reader" };

export type EventSearchOptions = {
  /** Test seam: a shorter time limit. */
  timeoutMs?: number;
  /** Test seam: runs once the slot is held, before the read. */
  beforeRead?: (tx: Prisma.TransactionClient) => Promise<unknown>;
};

const cut = (value: string | null): string | null => (value === null ? null : value.slice(0, FIELD_MAX));

/** A lake row as the search and a run's sample hold it: the typed columns only, each cut to `FIELD_MAX`. */
function toEventRow(r: LakeRow): EventRow {
  return {
    type: r.type,
    timestamp: r.ts.toISOString(),
    agentId: r.agentId.slice(0, FIELD_MAX),
    comm: cut(r.comm),
    path: cut(r.path),
    imagePath: cut(r.imagePath),
    daddr: cut(r.daddr),
    query: cut(r.query),
    sha256: cut(r.sha256),
  };
}

/**
 * Runs one search of the archive for `tenantId` as of `now`. `archive` says what can be read: `off`
 * is `lake_off` (the API answers 503), and `no_reader` is `no_reader` (the lake is on but its store
 * has no read side: a 501). Neither opens a transaction or takes a slot.
 */
export async function searchEventsWithinLimit(
  prisma: PrismaClient,
  archive: EventArchive,
  tenantId: string,
  query: EventQuery,
  now: Date = new Date(),
  options: EventSearchOptions = {}
): Promise<EventSearchOutcome> {
  if (archive.state === "off") return { status: "lake_off" };
  if (archive.state === "no_reader") return { status: "no_reader" };
  const { reader } = archive;
  const timeoutMs = options.timeoutMs ?? HUNT_STATEMENT_TIMEOUT_MS;
  const { from, to } = eventWindow(query, now);
  return prisma.$transaction(
    async (tx) => {
      if (!(await admitSearch(tx, tenantId))) return { status: "busy" } as const;
      await options.beforeRead?.(tx);
      const signal = AbortSignal.timeout(timeoutMs);
      const result = await queryLake(reader, {
        tenantId,
        from,
        to,
        types: query.types,
        where: query.where,
        limit: SEARCH_PAGE_SIZE,
        order: "desc",
        includeEvent: false,
        signal,
      });
      // queryLake checks the deadline only before a file: a last file that ran past it (plus the
      // transaction's margin) would return a page that the commit then loses to an expired
      // transaction, a 500. Throw the TimeoutError here instead, which is a 504.
      signal.throwIfAborted();
      const page: EventPage = {
        source: "events",
        truncated: result.truncated,
        incomplete: result.filesSkipped > 0,
        from,
        to,
        rows: result.rows.map(toEventRow),
      };
      return { status: "ok", page } as const;
    },
    { timeout: timeoutMs + (HUNT_TRANSACTION_TIMEOUT_MS - HUNT_STATEMENT_TIMEOUT_MS) }
  );
}

/** Events a run keeps as its sample: one page, as the search shows. */
export const HUNT_EVENT_SAMPLE_SIZE = SEARCH_PAGE_SIZE;

/** What a run of a saved event hunt records. */
export type EventHuntResult = {
  /** Events matching in the window, counted up to `MAX_ROWS` (1000): a floor when `truncated`. */
  matchCount: number;
  /** Of those, with an event time after `newSince` (all of them on the first run). */
  newMatchCount: number;
  /** The newest matches, at most `HUNT_EVENT_SAMPLE_SIZE`. */
  sample: EventRow[];
  /** More events matched than a run reads: `matchCount` is a floor. */
  truncated: boolean;
  /** The archive had more matching files than one run lists, so the oldest days were not read. */
  incomplete: boolean;
};

export type EventHuntOutcome = { status: "ok"; result: EventHuntResult } | { status: "busy" } | { status: "lake_off" } | { status: "no_reader" };

/**
 * Runs a saved event hunt for `tenantId` as of `now`: the same read, under the same three bounds, as
 * {@link searchEventsWithinLimit} (the deadline as an `AbortSignal`, one of the tenant's search slots,
 * typed columns only each cut to `FIELD_MAX`), but counting. It reads up to `MAX_ROWS` rows to give a
 * count and keeps only `HUNT_EVENT_SAMPLE_SIZE` of them, so a run's row stays small however many
 * events matched. `newSince` is the previous run's start: events are new by their own time, not by
 * when they reached the archive, so an event the agent sent late (before that start) is not new.
 */
export async function runEventHuntWithinLimit(
  prisma: PrismaClient,
  archive: EventArchive,
  tenantId: string,
  query: EventQuery,
  now: Date,
  newSince: Date | null,
  options: EventSearchOptions = {}
): Promise<EventHuntOutcome> {
  if (archive.state === "off") return { status: "lake_off" };
  if (archive.state === "no_reader") return { status: "no_reader" };
  const { reader } = archive;
  const timeoutMs = options.timeoutMs ?? HUNT_STATEMENT_TIMEOUT_MS;
  const { from, to } = eventWindow(query, now);
  return prisma.$transaction(
    async (tx) => {
      if (!(await admitSearch(tx, tenantId))) return { status: "busy" } as const;
      await options.beforeRead?.(tx);
      const signal = AbortSignal.timeout(timeoutMs);
      const found = await queryLake(reader, {
        tenantId,
        from,
        to,
        types: query.types,
        where: query.where,
        limit: MAX_ROWS,
        order: "desc",
        includeEvent: false,
        signal,
      });
      signal.throwIfAborted();
      const fresh = newSince === null ? found.rows.length : found.rows.filter((r) => r.ts.getTime() > newSince.getTime()).length;
      return {
        status: "ok",
        result: {
          matchCount: found.rows.length,
          newMatchCount: fresh,
          sample: found.rows.slice(0, HUNT_EVENT_SAMPLE_SIZE).map(toEventRow),
          truncated: found.truncated,
          incomplete: found.filesSkipped > 0,
        },
      } as const;
    },
    { timeout: timeoutMs + (HUNT_TRANSACTION_TIMEOUT_MS - HUNT_STATEMENT_TIMEOUT_MS) }
  );
}
