import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { DEFAULT_GEMINI_MODEL } from "../../../src/adapters/gemini-model";
import { analysisDigest } from "../../../src/domain/integrity";
import { runFixture, videoRunFixture } from "../test/fixtures";
import { collectClientErrors } from "./support/client-errors";

function syntheticMp4(bytes = 64): Buffer {
  const fixture = Buffer.alloc(bytes);
  fixture.writeUInt32BE(24, 0);
  fixture.write("ftypisom", 4, "ascii");
  for (let index = 12; index < fixture.length; index += 1) {
    fixture[index] = index % 251;
  }
  return fixture;
}

test("shows local work, connection health, and one clear start action", {
  tag: "@smoke",
}, async ({ page }) => {
  const clientErrors = collectClientErrors(page);

  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Turn a recording into findings." }),
  ).toBeVisible();
  await expect(page.locator('[data-studio-home="local"]')).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Active jobs" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Connections" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Recent runs" }),
  ).toBeVisible();
  await expect(page.getByRole("status")).toHaveCount(3);
  await expect(page.getByText("No analyses yet")).toBeVisible();
  const activeSummary = await page.getByTestId("active-jobs-summary").boundingBox();
  const recentSummary = await page.getByTestId("recent-runs-summary").boundingBox();
  expect(activeSummary).not.toBeNull();
  expect(recentSummary).not.toBeNull();
  expect(Math.abs(activeSummary!.y - recentSummary!.y)).toBeLessThanOrEqual(2);

  const newAnalysis = page.getByRole("link", { name: "Start an analysis" });
  await expect(newAnalysis).toHaveCount(1);
  await newAnalysis.click();
  await expect(
    page.getByRole("heading", { name: "Choose what this analysis should find." }),
  ).toBeVisible();
  expect(clientErrors).toEqual([]);
});

test("manages a temporary Gemini key without reflecting it", {
  tag: "@smoke",
}, async ({ page }) => {
  const clientErrors = collectClientErrors(page);
  const syntheticKey = "synthetic-e2e-key-never-use";

  const resetResponse = await page.request.delete(
    "/api/studio/configuration/secrets/gemini-api-key",
    {
      data: {},
      headers: { "content-type": "application/json" },
    },
  );
  expect(resetResponse.status()).toBe(200);

  await page.goto("/connections");
  await expect(
    page.getByRole("navigation", { name: "Studio navigation" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "New analysis" }),
  ).toBeVisible();
  const gemini = page.getByRole("region", { name: "Gemini connection" });
  await expect(gemini.getByRole("status")).toContainText("Not configured");

  await gemini.getByLabel("Gemini API key").fill(syntheticKey);
  const saveResponsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/api/studio/configuration/secrets/gemini-api-key")
    && response.request().method() === "PUT"
  );
  await gemini.getByRole("button", { name: "Use this key" }).click();
  const saveResponse = await saveResponsePromise;

  expect(saveResponse.status()).toBe(200);
  expect(await saveResponse.text()).not.toContain(syntheticKey);
  await expect(gemini.getByRole("status")).toContainText("Configured");
  await expect(gemini.getByLabel("Gemini API key")).toHaveValue("");
  expect(await page.locator("body").textContent()).not.toContain(syntheticKey);

  await gemini.getByRole("button", { name: "Clear temporary key" }).click();
  await expect(gemini.getByRole("status")).toContainText("Not configured");
  expect(clientErrors).toEqual([]);
});

test("keeps Bluedot reconnect controls visible when preselected", {
  tag: "@smoke",
}, async ({ page }) => {
  await page.goto(
    "/connections?provider=bluedot&returnTo=/activity/job_reconnect_0000001",
  );
  await expect(page.getByText("Reconnect Bluedot", { exact: true })).toBeVisible();
  const bluedot = page.locator('[data-selected-provider="bluedot"]');
  await expect(bluedot).toBeVisible();
  await expect(bluedot.getByRole("button", { name: /OAuth/ })).toBeVisible();
});

test("stages and deletes one synthetic recording through the browser", {
  tag: "@smoke",
}, async ({ page }) => {
  const clientErrors = collectClientErrors(page);

  await page.goto("/recording");
  await expect(
    page.getByRole("heading", {
      name: "Put one recording in the frame.",
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Selecting or staging does not contact Gemini.", {
      exact: false,
    }),
  ).toBeVisible();

  await page.getByLabel("Screen recording").setInputFiles({
    name: "synthetic-walkthrough.mp4",
    mimeType: "video/mp4",
    buffer: syntheticMp4(),
  });
  await expect(page.getByText("Recording selected.", { exact: false })).toBeVisible();

  await page.getByRole("button", { name: "Stage locally" }).click();
  await expect(
    page.getByText("Recording staged and sealed locally."),
  ).toBeVisible();
  await expect(
    page.getByText("64 B of 64 B confirmed locally"),
  ).toBeVisible();

  await page.getByRole("button", { name: "Delete staged copy" }).click();
  await expect(page.getByText("Staged recording deleted.")).toBeVisible();
  expect(clientErrors).toEqual([]);
});

test("accepts an actual drop and keyboard file selection", {
  tag: "@smoke",
}, async ({ page }) => {
  const clientErrors = collectClientErrors(page);
  await page.goto("/recording");
  const dropzone = page.locator('div[data-slot="base"][role="button"]');
  const droppedBytes = [...syntheticMp4()];
  const dataTransfer = await page.evaluateHandle((bytes) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(
      [new Uint8Array(bytes)],
      "dropped-walkthrough.mp4",
      { type: "video/mp4" },
    ));
    return transfer;
  }, droppedBytes);
  await dropzone.dispatchEvent("drop", { dataTransfer });
  await expect(dropzone).toContainText("dropped-walkthrough.mp4");

  await page.reload();
  const keyboardDropzone = page.locator('div[data-slot="base"][role="button"]');
  const chooserPromise = page.waitForEvent("filechooser");
  await keyboardDropzone.focus();
  await page.keyboard.press("Enter");
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: "keyboard-walkthrough.mp4",
    mimeType: "video/mp4",
    buffer: syntheticMp4(),
  });
  await expect(keyboardDropzone).toContainText("keyboard-walkthrough.mp4");
  const stageButton = page.getByRole("button", { name: "Stage locally" });
  await stageButton.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByText("Recording staged and sealed locally."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Delete staged copy" }).click();
  await expect(page.getByText("Staged recording deleted.")).toBeVisible();
  expect(clientErrors).toEqual([]);
});

test("selects Intent by keyboard and reports strict field errors", {
  tag: "@smoke",
}, async ({ page }) => {
  const clientErrors = collectClientErrors(page);
  await page.goto("/intent");
  await expect(
    page.getByRole("heading", { name: "Choose what this analysis should find." }),
  ).toBeVisible();

  const requirements = page.getByRole("radio", { name: /Requirements/ });
  await expect(requirements).toBeVisible();
  await page.getByRole("button", { name: "Save intent" }).click();
  await expect(page.locator("#intent-recipe-error")).toBeVisible();
  await expect(page.locator("#intent-recipe-error"))
    .toContainText("Choose one built-in recipe or validate a custom recipe.");

  await requirements.focus();
  await page.keyboard.press("Space");
  await expect(requirements).toBeChecked();

  await page.getByLabel("Optional focus").fill("x".repeat(10_001));
  await page.getByRole("button", { name: "Save intent" }).click();
  await expect(page.getByText("Focus must be 10,000 characters or fewer."))
    .toBeVisible();

  await page.getByLabel("Optional focus").fill("Prioritize acceptance criteria.");
  await page.getByRole("button", { name: "Save intent" }).click();
  await expect(page.getByText("Intent step saved")).toBeVisible();
  const builtInDraft = await page.evaluate(() => JSON.parse(
    sessionStorage.getItem("frame-of-mind:studio:intent-draft") || "null",
  ));
  expect(builtInDraft.recipe).toEqual({
    id: "requirements",
    revision: expect.any(String),
  });

  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Choose what this analysis should find." }),
  ).toBeVisible();
  await expect(page.getByRole("radio", { name: /Requirements/ })).toBeChecked();
  const restoredDraft = await page.evaluate(() => JSON.parse(
    sessionStorage.getItem("frame-of-mind:studio:intent-draft") || "null",
  ));
  expect(restoredDraft).toEqual(builtInDraft);
  expect(restoredDraft.recipe).toEqual({
    id: "requirements",
    revision: expect.any(String),
  });

  await page.getByRole("button", { name: "Start over" }).click();
  expect(await page.evaluate(() =>
    sessionStorage.getItem("frame-of-mind:studio:intent-draft")
  )).toBeNull();
  await expect(page.getByRole("radio", { name: /Requirements/ })).not.toBeChecked();

  await page.getByRole("button", { name: "Use a custom recipe" }).click();
  await expect(page.getByText("Custom recipes cannot run yet")).toBeVisible();
  await expect(page.getByText(/custom_recipe_staging_unavailable/)).toBeVisible();
  await page.getByLabel("Custom recipe JSON").fill(JSON.stringify({
    id: "synthetic-review",
    label: "Synthetic review",
    description: "Public-safe browser fixture.",
    indexInstruction: "Find synthetic evidence.",
    interrogationInstruction: "Verify synthetic evidence.",
    unexpected: true,
  }));
  await page.getByRole("button", { name: "Validate custom recipe" }).click();
  await expect(page.locator("#intent-custom-error"))
    .toContainText(/invalid input|unrecognized key/i);
  expect(await page.evaluate(() =>
    sessionStorage.getItem("frame-of-mind:studio:intent-draft")
  )).toBeNull();
  expect(clientErrors).toEqual([]);
});

test("creates and cancels one video-only analysis from Activity", {
  tag: "@smoke",
}, async ({ page }) => {
  const clientErrors = collectClientErrors(page, {
    ignoreConsoleError: (message) =>
      message.includes("Failed to load resource"),
  });

  await page.goto("/intent");
  await page.getByRole("radio", { name: /Requirements/ }).check();
  await page.getByRole("button", { name: "Save intent" }).click();
  await expect(page.getByText("Intent step saved")).toBeVisible();

  await page.goto("/recording");
  await page.getByLabel("Screen recording").setInputFiles({
    name: "synthetic-run-receipt.mp4",
    mimeType: "video/mp4",
    buffer: syntheticMp4(),
  });
  await page.getByRole("button", { name: "Stage locally" }).click();
  await expect(page.getByText("Recording staged and sealed locally."))
    .toBeVisible();

  await page.goto("/run");
  await expect(
    page.getByRole("heading", { name: "Review the exact run receipt." }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Requirements" }))
    .toBeVisible();
  await expect(page.getByText(
    "Add meeting context, or continue with the recording only.",
  )).toBeVisible();
  await expect(page.getByRole("link", { name: "Open context" })).toBeVisible();
  await page.getByRole("button", { name: "Continue without context" }).click();
  await expect(page.getByText("BLOCKED", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Video-only", { exact: true })).toBeVisible();
  const keyResponse = await page.request.put(
    "/api/studio/configuration/secrets/gemini-api-key",
    {
      data: { value: "synthetic-run-receipt-key-never-use" },
      headers: { "content-type": "application/json" },
    },
  );
  expect(keyResponse.status()).toBe(200);
  const start = page.getByRole("button", { name: "Start analysis" });
  await expect(start).toBeEnabled();
  const drafts = await page.evaluate(() => ({
    media: JSON.parse(
      sessionStorage.getItem("frame-of-mind:studio:media-upload") || "null",
    ) as { mediaSessionId: string },
    run: JSON.parse(
      sessionStorage.getItem("frame-of-mind:studio:run-draft") || "null",
    ) as { idempotencyKey: string },
  }));
  const mediaResponse = await page.request.get(
    `/api/studio/media/${encodeURIComponent(drafts.media.mediaSessionId)}`,
  );
  expect(mediaResponse.status()).toBe(200);
  const mediaReceipt = await mediaResponse.json() as {
    id: string;
    sha256: string;
    retention: { mode: "ephemeral"; expiresAt: string };
  };
  const e2eRoot = process.env.FRAME_OF_MIND_E2E_TEMP_ROOT;
  if (!e2eRoot) throw new Error("E2E temporary root is unavailable.");
  const seeded = spawnSync(
    "bun",
    ["apps/web/e2e/support/seed-cancelable-job.ts"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      input: JSON.stringify({
        databasePath: join(e2eRoot, "studio.sqlite"),
        idempotencyKey: drafts.run.idempotencyKey,
        mediaReceipt,
      }),
    },
  );
  if (seeded.status !== 0) {
    throw new Error(`Cancelable job fixture failed: ${seeded.stderr}`);
  }
  const createResponsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/api/studio/composer/jobs")
    && response.request().method() === "POST"
  );
  await start.click();
  const createResponse = await createResponsePromise;
  const createStatus = createResponse.status();
  if (createStatus !== 200 && createStatus !== 201) {
    throw new Error(`Job create failed (${createStatus}): ${await createResponse.text()}`);
  }
  const createdJob = await createResponse.json() as { job: { id: string } };

  await expect(page).toHaveURL(/\/?created=job_/);
  const notice = page.getByText(/Job job_.* durable local queue\./);
  await expect(notice).toBeVisible();
  expect(await page.evaluate(() => ({
    intent: sessionStorage.getItem("frame-of-mind:studio:intent-draft"),
    context: sessionStorage.getItem("frame-of-mind:studio:context-draft"),
    media: sessionStorage.getItem("frame-of-mind:studio:media-upload"),
    run: sessionStorage.getItem("frame-of-mind:studio:run-draft"),
  }))).toEqual({ intent: null, context: null, media: null, run: null });

  await page.goto("/activity");
  await expect(page.getByRole("main").getByRole("heading", {
    name: "Activity",
    level: 1,
  }))
    .toBeVisible();
  const activeSection = page.locator('section[aria-labelledby="activity-active"]');
  const activeJob = activeSection.locator(
    `a[href="/activity/${createdJob.job.id}"]`,
  );
  await expect(activeJob).toBeVisible();
  const activeRow = activeJob.locator("xpath=ancestor::tr");
  await expect(activeRow.locator("[data-activity-elapsed] > [aria-hidden=true]")).toHaveText(
    /\d+(?:h|m|s)/,
  );
  await expect(activeRow).toContainText("In progress");
  await expect(activeRow).toContainText("of 7");
  const cancelButton = activeSection.getByRole("button", {
    name: "Cancel Requirements attempt 1",
  });
  await cancelButton.click();
  await expect(activeRow.getByText("Cancel this analysis?")).toBeVisible();
  await activeRow.getByRole("button", { name: "Confirm Cancel" }).click();
  await expect.poll(async () => {
    const response = await page.request.get(
      `/api/studio/jobs/${encodeURIComponent(createdJob.job.id)}?afterSequence=0&limit=100`,
    );
    const detail = await response.json() as { job: { stage: string } };
    return detail.job.stage;
  }, { timeout: 60_000 }).toBe("canceled");

  await page.goto(`/activity/${createdJob.job.id}`);
  await expect(page).toHaveURL(`/activity/${createdJob.job.id}`);
  await expect(page.getByRole("heading", { name: "Timeline" })).toBeVisible();
  const timeline = page.locator('ol[aria-label="Job stage timeline"]');
  await expect(timeline.getByText("Cancellation requested", { exact: true }))
    .toBeVisible({ timeout: 15_000 });
  await expect(timeline.getByText("Canceled", { exact: true })).toBeVisible();
  const terminalResponse = await page.request.get(
    `/api/studio/jobs/${encodeURIComponent(createdJob.job.id)}?afterSequence=0&limit=100`,
  );
  const terminalDetail = await terminalResponse.json() as {
    job: { createdAt: string; terminal: { at: string } };
  };
  const frozenElapsedSeconds = Math.floor(
    (Date.parse(terminalDetail.job.terminal.at) - Date.parse(terminalDetail.job.createdAt))
      / 1_000,
  );
  const timing = page.locator('[data-activity-progress="honest"]');
  await expect(timing.getByText("Elapsed", { exact: true })).toBeVisible();
  await expect(timing.getByText("Last activity", { exact: true })).toBeVisible();
  await expect(timing.getByText("Current stage started", { exact: true })).toBeVisible();
  await expect(timing.getByText("Progress", { exact: true })).toBeVisible();
  await expect(timing.locator("[data-elapsed-seconds]")).toHaveAttribute(
    "data-elapsed-seconds",
    String(frozenElapsedSeconds),
  );
  await expect(timing.locator("[data-elapsed-seconds]")).toHaveAttribute(
    "data-terminal",
    "true",
  );
  await expect(timing.getByText("Canceled", { exact: true })).toBeVisible();
  await expect(timing.getByRole("progressbar")).toHaveCount(0);
  await page.getByText("Technical details", { exact: true }).click();
  const technicalDetails = page.locator('[data-technical-details="allowlisted"]');
  await expect(technicalDetails.getByText(createdJob.job.id, { exact: true })).toBeVisible();
  await expect(
    technicalDetails.locator("dt", { hasText: /^Stage$/ })
      .locator("xpath=following-sibling::dd[1]"),
  ).toHaveText("canceled");

  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText(value: string) {
          (window as typeof window & { __supportReceipt?: string }).__supportReceipt = value;
          return Promise.resolve();
        },
      },
    });
  });
  await technicalDetails.getByRole("button", { name: "Copy support receipt" }).click();
  await expect(technicalDetails.getByRole("status")).toHaveText("Support receipt copied.");
  expect(await page.evaluate(() =>
    (window as typeof window & { __supportReceipt?: string }).__supportReceipt
  )).toMatch(/^Frame of Mind support receipt v1\njob_id=job_/);

  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error("synthetic denial")) },
    });
  });
  await technicalDetails.getByRole("button", { name: "Copy support receipt" }).click();
  await expect(technicalDetails.getByLabel("Support receipt text")).toBeVisible();
  await expect(technicalDetails.getByLabel("Support receipt text"))
    .toHaveValue(/^Frame of Mind support receipt v1\njob_id=job_/);
  expect(clientErrors).toEqual([]);
});

test("keeps custom Intent saveable when the recipe catalog fails", {
  tag: "@smoke",
}, async ({ page }) => {
  const clientErrors = collectClientErrors(page, {
    ignoreConsoleError: (message) =>
      message === "Failed to load resource: the server responded with a status of 500 (Internal Server Error)",
  });
  await page.route("**/api/studio/recipes", async (route) => {
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ statusCode: 500 }),
    });
  });
  await page.goto("/intent");
  await expect(page.getByText("Studio could not load recipes — see logs."))
    .toBeVisible();

  await page.getByRole("button", { name: "Use a custom recipe" }).click();
  await page.getByLabel("Custom recipe JSON").fill(JSON.stringify({
    id: "catalog-independent-review",
    label: "Catalog-independent review",
    description: "A synthetic custom recipe for fallback coverage.",
    indexInstruction: "Find synthetic evidence.",
    interrogationInstruction: "Verify synthetic evidence.",
  }));
  await page.getByRole("button", { name: "Validate custom recipe" }).click();
  await page.getByRole("button", { name: "Save intent" }).click();
  await expect(page.getByText("Intent step saved")).toBeVisible();
  const draft = await page.evaluate(() => JSON.parse(
    sessionStorage.getItem("frame-of-mind:studio:intent-draft") || "null",
  ));
  expect(draft.model).toBe(DEFAULT_GEMINI_MODEL);
  expect(clientErrors).toEqual([]);
});

test("imports and reviews one synthetic run", {
  tag: "@smoke",
}, async ({ page }) => {
  const clientErrors = collectClientErrors(page);
  const fixture = runFixture();
  fixture.analysis.items[0]!.result.evidence = {
    timestamp: "00:00:12",
    reporterQuote: "<script data-synthetic-transcript>not executable</script>",
  };
  fixture.analysis.items.push({
    candidate: {
      start: "00:00:30",
      end: "00:00:40",
      summary: "A second synthetic candidate.",
      kind: "decision",
      importance: "medium",
    },
    result: {
      accepted: false,
      kind: "decision",
      title: "Keep external publishing out of scope",
      summary: "The local review export does not publish externally.",
    },
  });
  const reviewRecording = syntheticMp4();
  fixture.manifest.recordingSha256 = createHash("sha256")
    .update(reviewRecording)
    .digest("hex");
  fixture.manifest.analysisSha256 = await analysisDigest(fixture.analysis);

  await page.goto("/import");
  await page.getByLabel("analysis.json", { exact: true }).setInputFiles({
    name: "analysis.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(fixture.analysis)),
  });
  await page.getByLabel("manifest.json", { exact: true }).setInputFiles({
    name: "manifest.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(fixture.manifest)),
  });

  await page.getByRole("button", { name: "Validate and import" }).click();
  await expect(page.getByText("Run imported", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Open run" }).click();

  await expect(
    page.getByRole("heading", { name: "Product review", level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Use the portable contract",
      level: 3,
    }),
  ).toBeVisible();
  await expect(page.getByText("The database remains a projection.")).toBeVisible();

  await page.goto(`/review/${encodeURIComponent(fixture.manifest.runId)}`);
  await expect(page.locator('[data-studio-review="local"]')).toBeVisible();
  await expect(page.getByRole("heading", { name: "Product review", level: 1 }))
    .toBeVisible();
  await expect(page.getByRole("heading", { name: "Analysis records" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Candidate markers" })).toBeVisible();
  await expect(page.getByRole("button", {
    name: "Accepted candidate 1: Use the portable contract at 00:00:10",
  })).toBeVisible();
  await expect(page.getByText(
    "<script data-synthetic-transcript>not executable</script>",
    { exact: true },
  )).toBeVisible();
  await expect(page.getByText("Video 00:00:12 · Transcript 00:00:12 (+0s)"))
    .toBeVisible();
  await expect(page.locator("script[data-synthetic-transcript]")).toHaveCount(0);
  await expect(page.locator('[data-review-playback="unavailable"]')).toBeVisible();
  await page.keyboard.press("j");
  await expect(page.getByRole("heading", {
    name: "Keep external publishing out of scope",
    level: 3,
  })).toBeVisible();
  await page.keyboard.press("k");
  await expect(page.getByRole("heading", {
    name: "Use the portable contract",
    level: 3,
  })).toBeVisible();

  await page.getByLabel("Choose original recording").setInputFiles({
    name: "review.mp4",
    mimeType: "video/mp4",
    buffer: reviewRecording,
  });
  await expect(page.locator('[data-review-playback="available"]')).toBeVisible();

  await page.getByRole("button", { name: "Copy Markdown" }).click();
  await expect(page.getByText("Markdown copied.")).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download run bundle" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename())
    .toBe(`frame-of-mind-${fixture.manifest.runId}.run-bundle.json`);

  const acceptedFilter = page.getByRole("button", { name: "Accepted", exact: true });
  await acceptedFilter.focus();
  await page.keyboard.press("Enter");
  await expect(acceptedFilter).toHaveAttribute("aria-pressed", "true");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("heading", { name: "Detail" })).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 720 });

  await page.getByRole("link", { name: "Home", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Product review", exact: true }),
  ).toBeVisible();
  expect(clientErrors).toEqual([]);
});

test("imports and reviews one video-only run without meeting provenance", {
  tag: "@smoke",
}, async ({ page }) => {
  const clientErrors = collectClientErrors(page);
  const fixture = await videoRunFixture();

  await page.goto("/import");
  await page.getByLabel("analysis.json", { exact: true }).setInputFiles({
    name: "analysis.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(fixture.analysis)),
  });
  await page.getByLabel("manifest.json", { exact: true }).setInputFiles({
    name: "manifest.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(fixture.manifest)),
  });

  await page.getByRole("button", { name: "Validate and import" }).click();
  await expect(page.getByText("Run imported", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Open run" }).click();

  await expect(
    page.getByRole("heading", { name: "Issue review · Jul 28, 2026", level: 1 }),
  ).toBeVisible();
  await expect(page.getByText("recording only", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Fix the visible issue", level: 3 }),
  ).toBeVisible();

  await page.getByRole("link", { name: "Home", exact: true }).click();
  const runLink = page.getByRole("link", {
    name: "Video analysis",
    exact: true,
  });
  await expect(runLink).toBeVisible();
  await expect(runLink).toContainText("Issue review · video only");
  expect(clientErrors).toEqual([]);
});
