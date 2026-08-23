import { test as base } from "@playwright/test";
import {
  startHostedHarness,
  type HostedHarness,
} from "./hosted-harness";

export const test = base.extend<{}, { hosted: HostedHarness }>({
  hosted: [async ({}, use, workerInfo) => {
    const authMode = workerInfo.project.name.includes("better-auth")
      ? "better-auth"
      : "cloudflare-access";
    const hosted = await startHostedHarness(authMode);
    try {
      await use(hosted);
    } finally {
      await hosted.close();
    }
  }, { scope: "worker", timeout: 180_000 }],
});

export { expect } from "@playwright/test";
