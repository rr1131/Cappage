import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    projects: ["unit", "integration"].map((name) => ({
      resolve: {
        alias: {
          "server-only": fileURLToPath(new URL("./tests/server-only.ts", import.meta.url)),
          "@": fileURLToPath(new URL("./", import.meta.url)),
        },
      },
      test: {
        name,
        environment: "node",
        include: [`tests/${name}/**/*.test.ts`],
        testTimeout: 15_000,
        hookTimeout: 30_000,
      },
    })),
  },
});
