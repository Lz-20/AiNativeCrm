import { readFileSync } from "node:fs";

import { defineConfig } from "@playwright/test";

for (const line of readFileSync(".env.e2e", "utf8").split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const separator = trimmed.indexOf("=");
  if (separator > 0 && process.env[trimmed.slice(0, separator)] === undefined)
    process.env[trimmed.slice(0, separator)] = trimmed.slice(separator + 1);
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
if (!supabaseUrl.startsWith("http://127.0.0.1") && !supabaseUrl.startsWith("http://localhost"))
  throw new Error("live workbench verification refuses a non-local Supabase URL");

export default defineConfig({
  testDir: "..",
  outputDir: "../../../test-results",
  timeout: 240_000,
  workers: 1,
  retries: 0,
  use: {
    baseURL: process.env.LIVE_BASE_URL ?? "http://127.0.0.1:3009",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
          ? {
              launchOptions: {
                executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
              },
            }
          : {}),
      },
    },
  ],
});
