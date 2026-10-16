import { defineConfig } from "vitest/config";
import path from "node:path";
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    exclude: ["node_modules/**", ".next/**", "e2e/**"],
    coverage: {
      provider: "v8",
      include: ["src/lib/**/*.ts", "src/components/**/*.{ts,tsx}"],
      exclude: ["**/*.test.*"],
      thresholds: { lines: 80, functions: 80, statements: 80, branches: 80 },
    },
  },
});
