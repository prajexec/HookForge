import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
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
