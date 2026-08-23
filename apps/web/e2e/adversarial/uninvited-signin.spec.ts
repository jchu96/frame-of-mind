import { test, expect } from "@playwright/test";
import {
  hasBetterAuthSupport,
  startHostedHarness,
} from "../support/hosted-harness";

// REVIEW-fom-auth.md: an uninvited magic-link request must not reach the
// captured mailer. This activates when the Better Auth implementation lands.
test("@adversarial uninvited sign-in leaves the magic-link mailer empty", async () => {
  test.skip(!hasBetterAuthSupport(), "Better Auth PR #75 is not present on this base.");
  const hosted = await startHostedHarness("better-auth");
  try {
    const response = await fetch(`${hosted.baseUrl}/api/auth/sign-in/magic-link`, {
      method: "POST",
      headers: { origin: hosted.baseUrl, "content-type": "application/json" },
      body: JSON.stringify({ email: "uninvited@example.test" }),
    });
    expect([400, 403]).toContain(response.status);
    expect(hosted.mail).toHaveLength(0);
  } finally {
    await hosted.close();
  }
});
