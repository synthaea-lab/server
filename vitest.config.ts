import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.ts"],
    // Integration files share one Postgres database and each clears it between tests.
    fileParallelism: false,
    // better-auth reads NODE_ENV once, when it is imported, and skips its origin check under "test".
    // Inlined, it goes through vi.resetModules, so tests/unit/auth-trusted-origins.test.ts can import
    // it as production does.
    server: { deps: { inline: [/better-auth/] } },
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: [
        "node_modules/",
        "tests/",
        "*.config.{js,ts}",
        ".next/",
      ],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./"),
    },
  },
});
