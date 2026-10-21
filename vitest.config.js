import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          compatibilityDate: "2026-08-22",
          bindings: {
            TEST_MIGRATIONS: migrations,
            IP_SALT: "test-salt",
            TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
            TURNSTILE_SECRET: "1x0000000000000000000000000000000AA",
          },
        },
      }),
    ],
    test: { include: ["test/**/*.test.js"] },
  };
});
