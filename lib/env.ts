/**
 * Configuration read from the environment, in one place. Each reader takes the environment as an
 * argument (`process.env` at the call site) so a test can pass its own. A value that is set but wrong
 * throws: a typo must not silently mean "keep the default".
 */

/** What the readers below take: `process.env`, or a test's own object. */
export type Environment = Record<string, string | undefined>;

/**
 * A positive number from the environment, or `fallback` when unset or empty. With `integer`, a
 * fraction is refused too.
 */
export function positiveNumberFromEnv(
  env: Environment,
  name: string,
  fallback: number,
  { integer = false }: { integer?: boolean } = {}
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || (integer && !Number.isInteger(n))) {
    throw new Error(`${name} must be a positive ${integer ? "integer" : "number"}, got "${raw}"`);
  }
  return n;
}

/** A positive integer from the environment, or `fallback` when unset or empty. */
export function positiveIntFromEnv(env: Environment, name: string, fallback: number): number {
  return positiveNumberFromEnv(env, name, fallback, { integer: true });
}

/** The origins better-auth trusted before they were configurable (a development console and the nginx port). */
const DEFAULT_TRUSTED_ORIGINS = ["http://localhost:3000", "http://localhost:8443"];

/**
 * The origins better-auth accepts on a request that carries a session cookie (`lib/auth.ts`).
 * `AUTH_TRUSTED_ORIGINS` is a comma-separated list of `http(s)://host[:port]` origins. Unset, empty or
 * blank it is the two localhost origins, as before; set, it is the listed origins instead of those two.
 * An entry that is not an origin (no scheme, a path, a query, credentials) throws, and so does a value
 * with no entry at all (`","`). better-auth adds its own origins on top (see docs/security-model.md).
 */
export function authTrustedOrigins(env: Environment): string[] {
  const raw = env.AUTH_TRUSTED_ORIGINS;
  if (raw === undefined || raw.trim() === "") return [...DEFAULT_TRUSTED_ORIGINS];
  const entries = raw.split(",").map((e) => e.trim()).filter((e) => e !== "");
  if (entries.length === 0) throw new Error(`AUTH_TRUSTED_ORIGINS lists no origin, got "${raw}"`);
  return Array.from(new Set(entries.map(parseOrigin)));
}

/** True for `http(s)://host[:port]` and nothing more: no credentials, path, query or fragment. */
function isBareHttpOrigin(url: URL): boolean {
  const httpScheme = url.protocol === "http:" || url.protocol === "https:";
  const noCredentials = url.username === "" && url.password === "";
  const noPath = url.pathname === "/" || url.pathname === "";
  return httpScheme && noCredentials && noPath && url.search === "" && url.hash === "";
}

function parseOrigin(entry: string): string {
  const invalidOriginError = (cause?: unknown) =>
    new Error(`AUTH_TRUSTED_ORIGINS must list http(s)://host[:port] origins, got "${entry}"`, { cause });
  let url: URL;
  try {
    url = new URL(entry);
  } catch (error) {
    throw invalidOriginError(error);
  }
  if (!isBareHttpOrigin(url)) throw invalidOriginError();
  return url.origin;
}

/**
 * The secret nginx adds to every request as `X-Proxy-Secret` (`NGINX_PROXY_SECRET`). `undefined`
 * when unset or empty: the caller refuses every request then, it never treats "no secret" as a match.
 * The value is not trimmed: it is compared byte for byte with the header.
 */
export function proxySecret(env: Environment): string | undefined {
  return env.NGINX_PROXY_SECRET || undefined;
}

/** The bearer token of the `/api/cron/*` routes (`CRON_SECRET`). `undefined` when unset or empty: every job call is refused then. */
export function cronSecret(env: Environment): string | undefined {
  return env.CRON_SECRET || undefined;
}

/**
 * The `auth_user.id` values allowed to act before a tenant exists (`PLATFORM_OPERATOR_USER_IDS`,
 * comma-separated, entries trimmed, empty entries dropped). Unset or empty is an empty list: nobody is allowed.
 */
export function platformOperatorIds(env: Environment): string[] {
  return (env.PLATFORM_OPERATOR_USER_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

/** The port the Next.js server listens on (`PORT`, 3000 when unset or empty). A value that is not 1-65535 throws. */
export function listenPort(env: Environment): number {
  const raw = env.PORT;
  if (raw === undefined || raw === "") return 3000;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`PORT must be an integer from 1 to 65535, got "${raw}"`);
  return n;
}
