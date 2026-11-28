import { describe, expect, it } from "vitest";
import { DEFAULT_SNAPSHOT_PARAMS, guardFailure, snapshotParamsFromEnv } from "@/lib/content/snapshot-publish";

const params = { ...DEFAULT_SNAPSHOT_PARAMS, minHostsCovered: 5, minEntryFraction: 0.5 };
const at = (s: number) => new Date(s * 1000);
const prev = { builtAt: at(1000), hostsCovered: 10, entryCount: 100 };
const build = { hostsCovered: 10, entryCount: 100, builtAt: 2000 };

describe("guardFailure", () => {
  it("lets a healthy build through, with or without a previous one", () => {
    expect(guardFailure(params, build, null)).toBeNull();
    expect(guardFailure(params, build, prev)).toBeNull();
  });

  it("refuses a tenant with too few reporting hosts", () => {
    expect(guardFailure(params, { ...build, hostsCovered: 4 }, null)).toMatch(/only 4 hosts/);
    expect(guardFailure(params, { ...build, hostsCovered: 5 }, null)).toBeNull();
  });

  it("refuses a build that is not later than the one in force: the agent would refuse it", () => {
    expect(guardFailure(params, { ...build, builtAt: 1000 }, prev)).toMatch(/not later/);
    expect(guardFailure(params, { ...build, builtAt: 999 }, prev)).toMatch(/not later/);
    expect(guardFailure(params, { ...build, builtAt: 1001 }, prev)).toBeNull();
  });

  it("refuses a truncated build, unless the hosts covered fell too", () => {
    expect(guardFailure(params, { ...build, entryCount: 49 }, prev)).toMatch(/truncated/);
    expect(guardFailure(params, { ...build, entryCount: 50 }, prev)).toBeNull();
    // Fewer hosts reporting explains fewer common hashes.
    expect(guardFailure(params, { ...build, entryCount: 10, hostsCovered: 7 }, prev)).toBeNull();
  });

  it("compares with the previous snapshot only when there is one", () => {
    expect(guardFailure(params, { ...build, entryCount: 0 }, null)).toBeNull();
  });
});

describe("snapshotParamsFromEnv", () => {
  it("is the defaults when nothing is set", () => {
    expect(snapshotParamsFromEnv({})).toEqual(DEFAULT_SNAPSHOT_PARAMS);
  });

  it("takes each SNAPSHOT_* variable, fractions only where the parameter is a rate", () => {
    expect(
      snapshotParamsFromEnv({
        SNAPSHOT_MIN_HOSTS: "3",
        SNAPSHOT_MIN_HOSTS_COVERED: "4",
        SNAPSHOT_FALSE_POSITIVE_RATE: "0.001",
        SNAPSHOT_MAX_BYTES: "1000",
        SNAPSHOT_MAX_ENTRIES: "50",
        SNAPSHOT_MIN_ENTRY_FRACTION: "0.9",
      })
    ).toEqual({ minHosts: 3, minHostsCovered: 4, falsePositiveRate: 0.001, maxBytes: 1000, maxEntries: 50, minEntryFraction: 0.9 });
  });

  it("throws on a set value that is wrong, a fraction for a count included", () => {
    expect(() => snapshotParamsFromEnv({ SNAPSHOT_MIN_HOSTS: "2.5" })).toThrow("SNAPSHOT_MIN_HOSTS must be a positive integer");
    expect(() => snapshotParamsFromEnv({ SNAPSHOT_MAX_BYTES: "0" })).toThrow("SNAPSHOT_MAX_BYTES");
  });
});
