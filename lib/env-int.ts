/**
 * A positive integer from the environment, or `fallback` when unset. A value that is set but wrong
 * throws: a typo must not silently mean "keep the default".
 */
export function positiveIntFromEnv(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer, got "${raw}"`);
  return n;
}
