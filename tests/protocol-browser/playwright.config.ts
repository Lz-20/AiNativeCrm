import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 15000,
  use: {
    browserName: "chromium",
    // Local Windows can use its installed official Edge; CI leaves this unset
    // and uses the exact Playwright Chromium installed by release-safety-ci.
    channel: process.env.RECEIPT_TEST_CHANNEL === "msedge" ? "msedge" : undefined,
    trace: "on",
  },
  outputDir: "../../.superpowers/evidence/support-receipt-network",
});
