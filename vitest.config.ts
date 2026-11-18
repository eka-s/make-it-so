import { defineConfig } from "vitest/config";

// Test-only configuration. vite.config.ts (for the dev server) loads the ship config (config.ts),
// so if it were used, specifying `--ship` and `--root .` would be needed.
// Separated here, `npx vitest` alone works.
export default defineConfig({
  // For tests that load the client's .tsx. The same transform as "jsx": "react-jsx" in tsconfig.client.json
  // (needed because crewIcons.tsx evaluates JSX at module load time).
  esbuild: { jsx: "automatic" },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "node",
  },
});
