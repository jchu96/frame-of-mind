import { defineConfig, devices } from "@playwright/test";
import {
  E2E_BASE_URL,
  E2E_STORAGE_STATE,
} from "./apps/web/e2e/support/constants";

export default defineConfig({
  testDir: "./apps/web/e2e",
  outputDir: "./test-results/playwright/artifacts",
  preserveOutput: "failures-only",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI
    ? [["line"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: E2E_BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "setup",
      retries: 0,
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: "unauthenticated",
      testMatch: /unauthenticated\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "bootstrap-replay",
      dependencies: ["setup"],
      testMatch: /bootstrap-replay\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "chromium",
      dependencies: ["setup"],
      testMatch: /studio-smoke\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        storageState: E2E_STORAGE_STATE,
      },
    },
    {
      name: "mobile-chromium",
      dependencies: ["setup"],
      testMatch: /studio\.mobile\.spec\.ts/,
      use: {
        ...devices["Pixel 7"],
        storageState: E2E_STORAGE_STATE,
      },
    },
  ],
  webServer: {
    command: "bun run test:e2e:server",
    url: `${E2E_BASE_URL}/api/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
