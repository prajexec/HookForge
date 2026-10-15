import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // PostgreSQL integration files intentionally share one local database;
    // keep their project fixtures from competing for the global delivery queue.
    fileParallelism: false,
    include: [
      "apps/**/*.test.{ts,tsx}",
      "packages/**/*.test.ts",
      "tests/**/*.test.ts",
    ],
    coverage: {
      reporter: ["text", "html"],
      exclude: ["**/test/**", "**/*.d.ts"],
    },
  },
});
