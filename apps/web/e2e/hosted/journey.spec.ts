import { test, expect } from "../support/hosted-test";
import { hasBetterAuthSupport } from "../support/hosted-harness";

test.setTimeout(120_000);

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name.includes("better-auth") && !hasBetterAuthSupport(),
    "Better Auth PR #75 is not present on this base.",
  );
});

test("hosted composer publishes a reviewable run", async ({ browser, hosted }) => {
  const session = await hosted.session("a");
  const context = await browser.newContext(session.mode === "cloudflare-access"
    ? { extraHTTPHeaders: session.headers }
    : undefined);
  if (session.mode === "better-auth") {
    await context.addCookies(session.headers.cookie.split("; ").map((part) => {
      const separator = part.indexOf("=");
      return {
        name: part.slice(0, separator),
        value: part.slice(separator + 1),
        url: hosted.baseUrl,
      };
    }));
  }
  const page = await context.newPage();

  await page.goto(`${hosted.baseUrl}/hosted/new/intent`);
  await page.getByRole("button", { name: "Save intent" }).click();
  await page.getByRole("link", { name: "Continue to context" }).click();
  await page.getByRole("button", { name: "Use video only" }).click();
  await page.evaluate((mediaId) => {
    sessionStorage.setItem(
      "hosted:frame-of-mind:studio:media-upload",
      JSON.stringify({ schemaVersion: 1, mediaSessionId: mediaId }),
    );
  }, hosted.media.a);
  await page.getByRole("link", { name: "Continue to recording" }).click();
  await expect(page.locator("[data-hosted-media-ready=true]")).toBeVisible();
  await page.getByRole("link", { name: "Continue to run" }).click();
  await page.locator("[data-hosted-run-start=true]").click();
  await expect(page).toHaveURL(/\/hosted\/activity\/attempt_/);
  const attemptId = new URL(page.url()).pathname.split("/").at(-1)!;

  let runId = "";
  await expect.poll(async () => {
    const response = await context.request.get(
      `${hosted.baseUrl}/api/hosted/jobs/${encodeURIComponent(attemptId)}`,
    );
    const detail = await response.json() as {
      job: { stage: string; runId?: string };
    };
    runId = detail.job.runId || "";
    return detail.job.stage;
  }, { timeout: 60_000 }).toBe("succeeded");
  expect(runId).toMatch(/^hosted_attempt_/);

  await page.goto(`${hosted.baseUrl}/hosted/activity`);
  await expect(page.locator("[data-hosted-activity-page=list]")).toBeVisible();
  await page.goto(`${hosted.baseUrl}/hosted/activity/${encodeURIComponent(attemptId)}`);
  await expect(page.locator("[data-hosted-activity-page=detail]")).toBeVisible();
  await page.getByRole("link", { name: "Open published run" }).click();
  await expect(page).toHaveURL(new RegExp(`/runs/${runId}$`));
  await expect(page.getByRole("heading", { name: "Video analysis" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Analysis records" })).toBeVisible();

  await context.close();
});
