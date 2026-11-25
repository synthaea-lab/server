import { describe, expect, it } from "vitest";
import { authTrustedOrigins, cronSecret, listenPort, platformOperatorIds, positiveIntFromEnv, positiveNumberFromEnv, proxySecret } from "@/lib/env";

describe("positiveNumberFromEnv", () => {
  it("returns the fallback when the variable is unset or empty", () => {
    expect(positiveNumberFromEnv({}, "X", 7)).toBe(7);
    expect(positiveNumberFromEnv({ X: "" }, "X", 7)).toBe(7);
  });

  it("returns a positive number, a fraction included unless an integer is asked for", () => {
    expect(positiveNumberFromEnv({ X: "3" }, "X", 7)).toBe(3);
    expect(positiveNumberFromEnv({ X: "0.25" }, "X", 7)).toBe(0.25);
  });

  it("throws on a set value that is not a positive number, naming the variable and the value", () => {
    for (const bad of ["abc", "0", "-1", "Infinity", "NaN", "1e999"]) {
      expect(() => positiveNumberFromEnv({ X: bad }, "X", 7)).toThrow(`X must be a positive number, got "${bad}"`);
    }
  });

  it("refuses a fraction when an integer is asked for", () => {
    expect(positiveNumberFromEnv({ X: "4" }, "X", 7, { integer: true })).toBe(4);
    expect(() => positiveNumberFromEnv({ X: "2.5" }, "X", 7, { integer: true })).toThrow('X must be a positive integer, got "2.5"');
    expect(() => positiveNumberFromEnv({ X: "0" }, "X", 7, { integer: true })).toThrow('X must be a positive integer, got "0"');
  });
});

describe("positiveIntFromEnv", () => {
  it("keeps its answers: the fallback when unset, a positive integer, an error otherwise", () => {
    expect(positiveIntFromEnv({}, "N", 200)).toBe(200);
    expect(positiveIntFromEnv({ N: "" }, "N", 200)).toBe(200);
    expect(positiveIntFromEnv({ N: "50" }, "N", 200)).toBe(50);
    for (const bad of ["1.5", "0", "-3", "ten", "Infinity"]) {
      expect(() => positiveIntFromEnv({ N: bad }, "N", 200)).toThrow(`N must be a positive integer, got "${bad}"`);
    }
  });
});

describe("authTrustedOrigins", () => {
  const LOCAL = ["http://localhost:3000", "http://localhost:8443"];

  it("is the two localhost origins when AUTH_TRUSTED_ORIGINS is unset, empty or blank (today's value)", () => {
    expect(authTrustedOrigins({})).toEqual(LOCAL);
    expect(authTrustedOrigins({ AUTH_TRUSTED_ORIGINS: "" })).toEqual(LOCAL);
    expect(authTrustedOrigins({ AUTH_TRUSTED_ORIGINS: "  " })).toEqual(LOCAL);
  });

  it("is exactly the listed origins when set: localhost is not added back", () => {
    expect(authTrustedOrigins({ AUTH_TRUSTED_ORIGINS: "https://console.example.com" })).toEqual(["https://console.example.com"]);
    expect(authTrustedOrigins({ AUTH_TRUSTED_ORIGINS: "https://a.example.com, https://b.example.com:8443 ,," })).toEqual([
      "https://a.example.com",
      "https://b.example.com:8443",
    ]);
  });

  it("normalizes a trailing slash and the default port, and drops a duplicate", () => {
    expect(authTrustedOrigins({ AUTH_TRUSTED_ORIGINS: "https://a.example.com/,https://a.example.com:443" })).toEqual(["https://a.example.com"]);
  });

  it("throws on an entry that is not an http(s) origin, so a typo never means the default", () => {
    for (const bad of ["console.example.com", "ftp://a.example.com", "https://a.example.com/console", "https://a.example.com?x=1", "https://user@a.example.com", "*"]) {
      expect(() => authTrustedOrigins({ AUTH_TRUSTED_ORIGINS: `https://ok.example.com,${bad}` })).toThrow(/AUTH_TRUSTED_ORIGINS/);
    }
  });

  it("throws on a non-blank value with no entry, which would otherwise trust no origin silently", () => {
    for (const bad of [",", " , ", ",,"]) {
      expect(() => authTrustedOrigins({ AUTH_TRUSTED_ORIGINS: bad })).toThrow(/lists no origin/);
    }
  });
});

describe("proxySecret and cronSecret", () => {
  it("return the value as set, untrimmed", () => {
    expect(proxySecret({ NGINX_PROXY_SECRET: " s3 " })).toBe(" s3 ");
    expect(cronSecret({ CRON_SECRET: "c1" })).toBe("c1");
  });

  it("are undefined when unset or empty: the callers refuse, never match", () => {
    for (const env of [{}, { NGINX_PROXY_SECRET: "", CRON_SECRET: "" }]) {
      expect(proxySecret(env)).toBeUndefined();
      expect(cronSecret(env)).toBeUndefined();
    }
  });
});

describe("platformOperatorIds", () => {
  it("is empty when unset, empty or only separators: nobody is allowed", () => {
    expect(platformOperatorIds({})).toEqual([]);
    expect(platformOperatorIds({ PLATFORM_OPERATOR_USER_IDS: "" })).toEqual([]);
    expect(platformOperatorIds({ PLATFORM_OPERATOR_USER_IDS: " , ," })).toEqual([]);
  });

  it("lists the ids, trimmed, empty entries dropped", () => {
    expect(platformOperatorIds({ PLATFORM_OPERATOR_USER_IDS: "u1, u2 ,,u3" })).toEqual(["u1", "u2", "u3"]);
  });
});

describe("listenPort", () => {
  it("is 3000 when unset or empty", () => {
    expect(listenPort({})).toBe(3000);
    expect(listenPort({ PORT: "" })).toBe(3000);
  });

  it("is the port when it is an integer from 1 to 65535", () => {
    expect(listenPort({ PORT: "8080" })).toBe(8080);
    expect(listenPort({ PORT: "65535" })).toBe(65535);
  });

  it("throws on anything else, naming the value", () => {
    for (const bad of ["0", "65536", "-1", "80.5", "http", " "]) {
      expect(() => listenPort({ PORT: bad })).toThrow(`PORT must be an integer from 1 to 65535, got "${bad}"`);
    }
  });
});
