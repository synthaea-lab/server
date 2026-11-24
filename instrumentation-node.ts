import { authTrustedOrigins, type Environment } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { checkDecoyTable, checkShutdownOwnership, installDecoyShutdownFlush } from "@/lib/decoy";

/**
 * Decoy credentials (issue #81), at server start: finish the pending alarms when the process is
 * told to stop, and say if the table they live in does not exist. Node runtime only.
 */
export function startDecoyWatch(): void {
  checkShutdownOwnership();
  installDecoyShutdownFlush(process);
  void checkDecoyTable(prisma);
}

/**
 * Configuration that must be right for the server to be useful, checked at start. A throw from
 * Next's `register()` hook is wrapped and logged as "Failed to prepare server" while the process
 * keeps listening and answers every request with 500 (Next 14.2), so a bad value logs the cause
 * and exits with status 1, which a container orchestrator notices.
 */
export function assertStartupConfig(env: Environment, exit: (code: number) => never = process.exit): void {
  try {
    authTrustedOrigins(env);
  } catch (error) {
    console.error(`Invalid configuration, exiting: ${error instanceof Error ? error.message : String(error)}`);
    exit(1);
  }
}
