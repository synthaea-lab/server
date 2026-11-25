import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { requirePlatformOperator } from "@/lib/platform-operator";

const asUser = (id: string) => new NextRequest("http://localhost/x", { headers: { "x-user-id": id } });

afterEach(() => vi.unstubAllEnvs());

describe("requirePlatformOperator", () => {
  it("lets a listed user through, whatever the spacing around the list", async () => {
    vi.stubEnv("PLATFORM_OPERATOR_USER_IDS", "u1, u2 ,,u3");
    expect(await requirePlatformOperator(asUser("u2"))).toEqual({ userId: "u2" });
  });

  it("refuses a user who is not listed with 403", async () => {
    vi.stubEnv("PLATFORM_OPERATOR_USER_IDS", "u1");
    const result = await requirePlatformOperator(asUser("u9"));
    expect("response" in result && result.response.status).toBe(403);
  });

  it("refuses everyone when the list is unset, empty or only separators", async () => {
    for (const value of [undefined, "", " , "]) {
      vi.stubEnv("PLATFORM_OPERATOR_USER_IDS", value);
      const result = await requirePlatformOperator(asUser("u1"));
      expect("response" in result && result.response.status).toBe(403);
    }
  });
});
