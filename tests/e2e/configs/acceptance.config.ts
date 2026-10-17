/** Local-only acceptance against the existing production build and isolated E2E fixtures. */
import { defineConfig } from "@playwright/test";
import base from "../../../playwright.config";

const origin = "http://127.0.0.1:3012";
// The confirmation callback and the browser must use this same isolated origin.
process.env.NEXT_PUBLIC_APP_URL = origin;
export default defineConfig({
  ...base,
  testDir: "..",
  globalTeardown: "../global-teardown.ts",
  outputDir: "../../../test-results",
  use: { ...base.use, baseURL: origin },
  webServer: {
    cwd: process.cwd(),
    command: "pnpm exec next start --hostname 127.0.0.1 --port 3012",
    url: origin,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { NEXT_PUBLIC_APP_URL: origin },
  },
  projects: [
    {
      name: "chromium-local-acceptance",
      use: {
        browserName: "chromium",
        launchOptions: {
          executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
          args: ["--no-proxy-server"],
        },
      },
    },
  ],
});
