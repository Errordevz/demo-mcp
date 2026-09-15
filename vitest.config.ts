import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      // The Worker entrypoint imports `cloudflare:workers` for the Durable
      // Object base class; Node tests use a tiny stub instead.
      "cloudflare:workers": fileURLToPath(new URL("./tests/helpers/cloudflare-workers-stub.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
