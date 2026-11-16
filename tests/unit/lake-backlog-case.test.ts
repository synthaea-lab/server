import { describe, expect, it } from "vitest";
import {
  lakeBacklogBreach,
  lakeBacklogCaseDescription,
  lakeBacklogLimitsFromEnv,
} from "@/lib/lake-backlog-case";

const LIMITS = { maxAgeMs: 900_000, maxBatches: 100 };

describe("lakeBacklogBreach", () => {
  it("is within both limits for an empty queue", () => {
    expect(lakeBacklogBreach({ batches: 0, events: 0, oldestAgeMs: null }, LIMITS)).toBeNull();
  });

  it("is not over a limit at the limit itself", () => {
    expect(lakeBacklogBreach({ batches: 100, events: 1, oldestAgeMs: 900_000 }, LIMITS)).toBeNull();
  });

  it("names the age when the oldest batch is too old", () => {
    expect(lakeBacklogBreach({ batches: 1, events: 1, oldestAgeMs: 900_001 }, LIMITS)).toBe("age");
  });

  it("names the batch count when the queue is too long but young", () => {
    expect(lakeBacklogBreach({ batches: 101, events: 500, oldestAgeMs: 1_000 }, LIMITS)).toBe("batches");
  });

  it("names the age first when both limits are crossed", () => {
    expect(lakeBacklogBreach({ batches: 101, events: 500, oldestAgeMs: 2_000_000 }, LIMITS)).toBe("age");
  });
});

describe("lakeBacklogCaseDescription", () => {
  it("says what was crossed and what is queued", () => {
    const text = lakeBacklogCaseDescription({ batches: 7, events: 42, oldestAgeMs: 1_200_000 }, "age", LIMITS);
    expect(text).toContain("20 min old (limit 15 min)");
    expect(text).toContain("7 batches, 42 events");
  });
});

describe("lakeBacklogLimitsFromEnv", () => {
  it("defaults to 15 minutes and 5000 batches", () => {
    expect(lakeBacklogLimitsFromEnv({})).toEqual({ maxAgeMs: 900_000, maxBatches: 5_000 });
  });

  it("reads both variables", () => {
    expect(lakeBacklogLimitsFromEnv({ LAKE_BACKLOG_MAX_AGE_MINUTES: "5", LAKE_BACKLOG_MAX_BATCHES: "10" })).toEqual({
      maxAgeMs: 300_000,
      maxBatches: 10,
    });
  });

  it("refuses a value that is set but wrong, instead of using the default", () => {
    expect(() => lakeBacklogLimitsFromEnv({ LAKE_BACKLOG_MAX_BATCHES: "many" })).toThrow(/LAKE_BACKLOG_MAX_BATCHES/);
    expect(() => lakeBacklogLimitsFromEnv({ LAKE_BACKLOG_MAX_AGE_MINUTES: "0" })).toThrow(/LAKE_BACKLOG_MAX_AGE_MINUTES/);
  });
});
