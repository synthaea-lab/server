import { describe, expect, it } from "vitest";
import { HuntValidationError, RunUnavailableError, describeRunError } from "@/lib/hunt";
import { isEventQuery, parseHuntInput, parseSavedHuntQuery, sameQuery } from "@/lib/hunt-input";
import { EMPTY_HUNT_FORM, huntFormToBody, huntQueryIsValid, huntToFormValues } from "@/lib/hunt-form";
import { describeQuery, runSummary } from "@/lib/hunt-view";

const events = { kind: "events", version: 1, lastDays: 7, types: ["exec", "dns_query"], where: { imagePath: "/tmp/x", comm: "bash" } };

describe("parseSavedHuntQuery", () => {
  it("takes an events query by its kind and a detection query without one", () => {
    const e = parseSavedHuntQuery(events);
    expect(isEventQuery(e)).toBe(true);
    const d = parseSavedHuntQuery({ version: 1, lastHours: 24 });
    expect(isEventQuery(d)).toBe(false);
  });

  it("refuses a mix of the two, an unknown kind and a filter the archive does not have", () => {
    for (const bad of [{ ...events, lastHours: 24 }, { ...events, kind: "cases" }, { ...events, where: { tenantId: "x" } }, { kind: "events", version: 1 }, { version: 1, lastHours: 24, kind: "events" }]) {
      expect(() => parseSavedHuntQuery(bad)).toThrow(HuntValidationError);
    }
  });

  it("is what a create body is validated with", () => {
    expect(parseHuntInput({ name: "n", query: events }, false).query).toMatchObject({ kind: "events", lastDays: 7 });
    expect(() => parseHuntInput({ name: "n", query: { ...events, lastDays: 0 } }, false)).toThrow(HuntValidationError);
  });
});

describe("sameQuery over events", () => {
  it("ignores key and list order, and sees a changed filter or window", () => {
    const a = parseSavedHuntQuery(events);
    const b = parseSavedHuntQuery({ where: { comm: "bash", imagePath: "/tmp/x" }, types: ["dns_query", "exec"], lastDays: 7, version: 1, kind: "events" });
    expect(sameQuery(a, b)).toBe(true);
    expect(sameQuery(a, parseSavedHuntQuery({ ...events, lastDays: 8 }))).toBe(false);
    expect(sameQuery(a, parseSavedHuntQuery({ ...events, where: { comm: "sh" } }))).toBe(false);
    expect(sameQuery(a, parseSavedHuntQuery({ version: 1, lastHours: 24 }))).toBe(false);
  });
});

describe("describeRunError", () => {
  it("passes an archive-unavailable note through, and calls a read deadline a time limit", () => {
    expect(describeRunError(new RunUnavailableError("the event archive is off"))).toBe("the event archive is off");
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    expect(describeRunError(timeout)).toBe("the search exceeded its time limit and was cancelled");
    expect(describeRunError(new Error("connect ECONNREFUSED 10.0.0.1:5432"))).toBe("the run failed (see the server log)");
  });
});

describe("the console's view of an events hunt", () => {
  it("describes the query in one line", () => {
    expect(describeQuery(events)).toBe("events · last 7 d · exec, dns_query · imagePath=/tmp/x · comm=bash");
    expect(describeQuery({ kind: "events", version: 1 })).toBe("stored query no longer valid");
  });

  it("says a count is a floor and that old days were not read", () => {
    expect(runSummary({ run: { matchCount: 1000, newMatchCount: 3, truncated: true, incomplete: true } })).toBe("Done: 1000+ matches, 3 new. The oldest days were not read.");
    expect(runSummary({ run: { matchCount: 1, newMatchCount: 1 } })).toBe("Done: 1 match, 1 new.");
  });

  it("round-trips an events hunt through the form without turning it into a detection hunt", () => {
    const values = huntToFormValues({ name: "h", description: null, query: events, scheduleMinutes: 60, active: true });
    expect(values).toMatchObject({ source: "events", lastDays: "7", types: "exec, dns_query" });
    expect(values.where.imagePath).toBe("/tmp/x");
    const result = huntFormToBody(values);
    expect(result).toMatchObject({ ok: true, body: { query: events, scheduleMinutes: 60 } });
    expect(huntQueryIsValid(events)).toBe(true);
  });

  it("leaves empty archive fields out and reports a bad window as the API would", () => {
    const base = { ...EMPTY_HUNT_FORM, name: "h", source: "events" as const };
    expect(huntFormToBody(base)).toMatchObject({ ok: true, body: { query: { kind: "events", version: 1, lastDays: 7 } } });
    const body = huntFormToBody(base);
    if (body.ok) expect(body.body.query).not.toHaveProperty("where");
    expect(huntFormToBody({ ...base, lastDays: "0" })).toMatchObject({ ok: false });
    expect(huntFormToBody({ ...base, lastDays: "ten" })).toMatchObject({ ok: false, error: "The window (days) must be a whole number" });
  });
});
