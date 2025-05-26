import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "dotenv";
import { defineConfig } from "vitest/config";

const env = parse(
  await readFile(join(process.cwd(), ".env.test"), { encoding: "utf-8" }),
);

export default defineConfig(() => ({
  test: {
    env: env,
    reporters: process.env.GITHUB_ACTIONS
      ? ["default", "github-actions"]
      : ["default"],
    fileParallelism: false,
    expect: {
      requireAssertions: true,
    },
    coverage: {
      include: ["src/**/*.ts", "src/**/*.tsx"],
      // These files don't really make sense to try to collect coverage on as
      // they're setup files:
      exclude: [
        "src/env.ts",
        "src/logging.ts",
        "src/sentry.ts",
        // database setup:
        "src/db.ts",
        "src/schema.ts",
        // storage setup:
        "src/storage.ts",
      ],
    },
  },
}));
