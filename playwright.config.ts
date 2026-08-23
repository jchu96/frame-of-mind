import { defineConfig, devices, type PlaywrightTestConfig } from "@playwright/test";
import {
  E2E_BASE_URL,
  E2E_STORAGE_STATE,
} from "./apps/web/e2e/support/constants";
import { createE2EEnvironment } from "./scripts/e2e-environment";

const suite = process.env.FRAME_OF_MIND_E2E_SUITE || "smoke";
const runId = process.env.FRAME_OF_MIND_E2E_RUN_ID || "manual";
const includes = (name: "smoke" | "hosted" | "adversarial" | "canary") =>
  suite === name
  || suite === "all"
  || (suite === "ci" && name !== "canary")
  || (suite === "check" && (name === "hosted" || name === "adversarial"));

const projects: NonNullable<PlaywrightTestConfig["projects"]> = [];
if (includes("smoke")) {
  projects.push(
    {
      name: "smoke-setup",
      retries: 0,
      testDir: "./apps/web/e2e/smoke",
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: "smoke-unauthenticated",
      testDir: "./apps/web/e2e/smoke",
      testMatch: /unauthenticated\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "smoke-bootstrap-replay",
      dependencies: ["smoke-setup"],
      testDir: "./apps/web/e2e/smoke",
      testMatch: /bootstrap-replay\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "smoke-chromium",
      dependencies: ["smoke-setup"],
      testDir: "./apps/web/e2e/smoke",
      testMatch: /studio-(?:smoke|upload)\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], storageState: E2E_STORAGE_STATE },
    },
    {
      name: "smoke-mobile",
      dependencies: ["smoke-setup"],
      testDir: "./apps/web/e2e/smoke",
      testMatch: /studio\.mobile\.spec\.ts/,
      use: { ...devices["Pixel 7"], storageState: E2E_STORAGE_STATE },
    },
  );
}
if (includes("hosted")) {
  projects.push(
    {
      name: "hosted-cloudflare-access",
      testDir: "./apps/web/e2e/hosted",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "hosted-better-auth",
      testDir: "./apps/web/e2e/hosted",
      testMatch: /journey\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
  );
}
if (includes("adversarial")) {
  projects.push({
    name: "adversarial",
    testDir: "./apps/web/e2e/adversarial",
    use: { ...devices["Desktop Chrome"] },
  });
}
if (includes("canary")) {
  projects.push({
    name: "canary",
    testDir: "./apps/web/e2e/canary",
    use: { ...devices["Desktop Chrome"] },
  });
}

export default defineConfig({
  testDir: "./apps/web/e2e",
  outputDir: `./test-results/playwright/${runId}/artifacts`,
  preserveOutput: "failures-only",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI
    ? [["line"], ["html", { open: "never", outputFolder: `playwright-report/${runId}` }]]
    : [["list"], ["html", { open: "never", outputFolder: `playwright-report/${runId}` }]],
  use: {
    baseURL: E2E_BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    launchOptions: { env: createE2EEnvironment(process.env) },
  },
  projects,
  ...(includes("smoke")
    ? {
        webServer: {
          command: "bun --no-env-file run test:e2e:server",
          url: `${E2E_BASE_URL}/api/health`,
          reuseExistingServer: false,
          timeout: 180_000,
          gracefulShutdown: { signal: "SIGTERM" as const, timeout: 5_000 },
          stdout: "pipe" as const,
          stderr: "pipe" as const,
        },
      }
    : {}),
});
