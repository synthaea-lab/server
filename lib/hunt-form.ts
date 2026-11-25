import { HUNT_QUERY_VERSION, HuntValidationError, SEVERITIES, type Severity } from "@/lib/hunt";
import { EVENT_FILTERS, EVENT_QUERY_VERSION, type EventFilterName } from "@/lib/hunt-events";
import { isEventQuery, parseHuntInput, parseSavedHuntQuery } from "@/lib/hunt-input";

/**
 * The create and edit form of a saved hunt (#61), as pure functions: the page holds the
 * form's text fields, these turn them into the body `POST /api/hunts` and
 * `PATCH /api/hunts/[id]` take, and a stored hunt back into text fields. The same
 * validation the API runs (`parseHuntInput`) gives the message shown before anything is sent.
 */

export type HuntFormValues = {
  name: string;
  description: string;
  /** What the hunt reads: the detection store, or the raw event archive (the telemetry lake). */
  source: "detections" | "events";
  /** Events only: the window in UTC days, as typed. */
  lastDays: string;
  /** Events only: event types separated by commas, spaces or new lines. */
  types: string;
  /** Events only: exact matches on typed columns; empty ones are left out. */
  where: Record<EventFilterName, string>;
  /** The window in hours, as typed. */
  lastHours: string;
  /** ATT&CK ids separated by commas, spaces or new lines. */
  techniques: string;
  severities: Severity[];
  /** Agent ids separated by commas, spaces or new lines. */
  agentIds: string;
  text: string;
  /** Minutes between runs, as typed; empty is manual only. */
  scheduleMinutes: string;
  active: boolean;
};

const EMPTY_EVENT_FILTERS = Object.fromEntries(EVENT_FILTERS.map((name) => [name, ""])) as Record<EventFilterName, string>;

export const EMPTY_HUNT_FORM: HuntFormValues = {
  name: "",
  description: "",
  source: "detections",
  lastDays: "7",
  types: "",
  where: EMPTY_EVENT_FILTERS,
  lastHours: "168",
  techniques: "",
  severities: [],
  agentIds: "",
  text: "",
  scheduleMinutes: "",
  active: true,
};

export type HuntFormResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; error: string };

function splitList(value: string): string[] {
  return value.split(/[\s,;]+/).filter((item) => item.length > 0);
}

function wholeNumber(value: string, what: string): number {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) throw new HuntValidationError(`${what} must be a whole number`);
  return Number(trimmed);
}

function eventQueryFromForm(values: HuntFormValues): Record<string, unknown> {
  const query: Record<string, unknown> = { kind: "events", version: EVENT_QUERY_VERSION, lastDays: wholeNumber(values.lastDays, "The window (days)") };
  const types = splitList(values.types);
  if (types.length > 0) query.types = types;
  const where = Object.fromEntries(EVENT_FILTERS.flatMap((name) => (values.where[name].trim().length > 0 ? [[name, values.where[name].trim()]] : [])));
  if (Object.keys(where).length > 0) query.where = where;
  return query;
}

function detectionQueryFromForm(values: HuntFormValues): Record<string, unknown> {
  const query: Record<string, unknown> = { version: HUNT_QUERY_VERSION, lastHours: wholeNumber(values.lastHours, "The window (hours)") };
  const techniques = splitList(values.techniques).map((t) => t.toUpperCase());
  if (techniques.length > 0) query.techniques = techniques;
  if (values.severities.length > 0) query.severities = values.severities;
  const agentIds = splitList(values.agentIds);
  if (agentIds.length > 0) query.agentIds = agentIds;
  if (values.text.trim().length > 0) query.text = values.text;
  return query;
}

/**
 * The request body for a form. An empty field is left out of the query (never sent as an
 * empty list or string, which the API refuses), an empty schedule is `null` (manual only),
 * and an empty description is `null`, so an edit clears it.
 */
export function huntFormToBody(values: HuntFormValues): HuntFormResult {
  try {
    const query = values.source === "events" ? eventQueryFromForm(values) : detectionQueryFromForm(values);

    const body = {
      name: values.name,
      description: values.description.trim().length > 0 ? values.description : null,
      query,
      scheduleMinutes: values.scheduleMinutes.trim().length > 0 ? wholeNumber(values.scheduleMinutes, "The schedule (minutes)") : null,
      active: values.active,
    };
    parseHuntInput(body, false);
    return { ok: true, body };
  } catch (error) {
    if (error instanceof HuntValidationError) return { ok: false, error: error.message };
    throw error;
  }
}

/**
 * A stored hunt as form fields. A stored query that no longer parses (ADR-0025 point 4)
 * opens as the default query (last 7 days, no filter), so saving the form repairs the hunt;
 * [`huntQueryIsValid`] tells the page to warn about it.
 */
export function huntToFormValues(hunt: {
  name: string;
  description: string | null;
  query: unknown;
  scheduleMinutes: number | null;
  active: boolean;
}): HuntFormValues {
  const values: HuntFormValues = {
    ...EMPTY_HUNT_FORM,
    name: hunt.name,
    description: hunt.description ?? "",
    scheduleMinutes: hunt.scheduleMinutes === null ? "" : String(hunt.scheduleMinutes),
    active: hunt.active,
  };
  try {
    const query = parseSavedHuntQuery(hunt.query);
    if (isEventQuery(query)) {
      values.source = "events";
      values.lastDays = String(query.lastDays);
      values.types = (query.types ?? []).join(", ");
      values.where = { ...EMPTY_EVENT_FILTERS, ...query.where };
    } else {
      values.lastHours = String(query.lastHours);
      values.techniques = (query.techniques ?? []).join(", ");
      values.severities = SEVERITIES.filter((s) => query.severities?.includes(s));
      values.agentIds = (query.agentIds ?? []).join("\n");
      values.text = query.text ?? "";
    }
  } catch (error) {
    if (!(error instanceof HuntValidationError)) throw error;
  }
  return values;
}

/**
 * Whether a stored query still parses. When it does not, [`huntToFormValues`] opens the form on
 * the default query, and saving would replace the stored one: the edit page says so.
 */
export function huntQueryIsValid(query: unknown): boolean {
  try {
    parseSavedHuntQuery(query);
    return true;
  } catch (error) {
    if (error instanceof HuntValidationError) return false;
    throw error;
  }
}

/** What the form shows of the answer of the API: the API's own message, or the status. */
export function saveResponseMessage(status: number, body: unknown): string {
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  if (typeof record.error === "string" && record.error) return record.error;
  return `Request failed with status ${status}`;
}
