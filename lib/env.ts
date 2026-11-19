/**
 * Configuration read from the environment, in one place. Each reader takes the environment as an
 * argument (`process.env` at the call site) so a test can pass its own. A value that is set but wrong
 * throws: a typo must not silently mean "keep the default".
 */

/**
 * A positive number from the environment, or `fallback` when unset or empty. With `integer`, a
 * fraction is refused too.
 */
export function positiveNumberFromEnv(
  env: Record<string, string | undefined>,
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
export function positiveIntFromEnv(env: Record<string, string | undefined>, name: string, fallback: number): number {
  return positiveNumberFromEnv(env, name, fallback, { integer: true });
}

/** The origins better-auth trusted before they were configurable (a development console and the nginx port). */
const DEFAULT_TRUSTED_ORIGINS = ["http://localhost:3000", "http://localhost:8443"];

/**
 * The origins better-auth accepts on a request that carries a session cookie (`lib/auth.ts`).
 * `AUTH_TRUSTED_ORIGINS` is a comma-separated list of `http(s)://host[:port]` origins. Unset, empty or
 * blank it is the two localhost origins, as before; set, it is exactly the listed origins, so a
 * production console is not also trusted from localhost. An entry that is not an origin (no scheme, a
 * path, a query, credentials) throws.
 */
export function authTrustedOrigins(env: Record<string, string | undefined>): string[] {
  const raw = env.AUTH_TRUSTED_ORIGINS;
  if (raw === undefined || raw.trim() === "") return [...DEFAULT_TRUSTED_ORIGINS];
  const origins = new Set<string>();
  for (const entry of raw.split(",").map((e) => e.trim()).filter((e) => e !== "")) {
    origins.add(parseOrigin(entry));
  }
  return Array.from(origins);
}

function parseOrigin(entry: string): string {
  const invalid = () => new Error(`AUTH_TRUSTED_ORIGINS must list http(s)://host[:port] origins, got "${entry}"`);
  let url: URL;
  try {
    url = new URL(entry);
  } catch {
    throw invalid();
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "" || (url.pathname !== "/" && url.pathname !== "") || url.search !== "" || url.hash !== "") {
    throw invalid();
  }
  return url.origin;
}
