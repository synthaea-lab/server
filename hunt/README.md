# Threat hunting

Analyst-driven hunting: ad-hoc searches over detections, cases and the telemetry archive, saved
hunts with a schedule and a result history, and drafts of detection content built from what a hunt
found.

## Built

- **Saved hunts.** A structured, versioned query over the tenant's detections (`lastHours`,
  `techniques`, `severities`, `agentIds`, `text`; not SQL), with an owner, an optional schedule and
  a run history. API: `GET`/`POST /api/hunts`, `GET`/`PATCH`/`DELETE /api/hunts/[id]`,
  `POST /api/hunts/[id]/run`. The `run-hunts` scheduled job runs the hunts that are due and prunes
  old runs.
- **Saved hunts over the event archive.** A hunt's `query` may be an event query (`kind: "events"`,
  `version: 1`, `lastDays` 1 to 90, `types`, exact `where` filters), validated like the search's. A run
  reads the [archive](../datalake/README.md) through the same bounds as the search: a 10-second
  deadline, one of the tenant's two search slots, typed columns only each cut to 256 characters. It
  counts up to 1000 matching events (`matchCount`, with `truncated` when there were more), keeps the
  newest 50 as `sampleEvents`, and counts as new (`newMatchCount`) the events whose own time is after
  the previous run started. `incomplete` says the archive had more files than one run lists, so the
  oldest days were not read. A run that cannot read the archive (off, no reader, slots taken, past
  its deadline) is recorded as failed with the reason; it is not retried before the next schedule.
  `GET /api/hunts/[id]/matches` returns the newest events of the window; graduation is refused (`422`),
  since drafts are made from detections.
- **Search.** `POST /api/hunts/search` returns one page of detections, of cases (`kind: "cases"`)
  or of archived events (`source: "events"`). Detection and case searches return 50 rows a page,
  newest first, with a keyset cursor. Each tenant has at most two searches in flight across server
  instances (`429` past that), and a search that runs too long answers `504`. A row carries ids,
  times, technique, severity, the case title and the rule title, never the rest of the stored
  event. `GET /api/hunts/[id]/matches` shows what a saved hunt matches now without recording a run.
- **Event archive search.** With `source: "events"`, the search reads the
  [telemetry archive](../datalake/README.md): up to 90 days, filtered by event type and exact
  matches on `agentId`, `comm`, `path`, `imagePath`, `daddr`, `query` and `sha256`. It returns the
  newest 50 events, typed columns only, within a 10-second deadline, and answers `503` while the
  archive is off.
- **Graduation.** `POST /api/hunts/[id]/graduate` drafts a Sigma rule and its samples file from
  the hunt's latest finished run, for a person to review and propose to the
  [rules](https://github.com/synthaea-lab/rules) repository. With `{ "kind": "ioc" }` it drafts an
  IOC feed file of the hashes, addresses and domains in the matches, each annotated with its fleet
  prevalence. Nothing is written server-side.
- **Console.** `/console/hunts` lists hunts with their latest results; hunts (detections or event archive) can be created,
  edited, run, deleted and, for detections, graduated from there, and an event hunt's page shows the events of its latest run, and `/console/hunts/search` runs ad-hoc searches.

## Not built

- A cursor over the event archive, and event search on the console's search page (the saved hunts have their own console pages).
- Opening the rules pull request from the server, and YARA drafts.
- Live queries to an endpoint, which will use the agent's live-response channel.

Code: `lib/hunt*.ts`, `app/api/hunts/`, `app/console/hunts/`, `components/*Hunt*.tsx`. Tests:
`tests/integration/hunts.test.ts`, `hunt-search.test.ts`, `notify-hunt-matches.test.ts`.
