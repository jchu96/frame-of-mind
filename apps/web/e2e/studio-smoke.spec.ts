import { expect, test } from "@playwright/test";
import { DEFAULT_GEMINI_MODEL } from "../../../src/adapters/gemini";
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
    page.getByRole("heading", { name: "Your local analysis desk." }),
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

  const newAnalysis = page.getByRole("link", { name: "Define intent" });
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
  await gemini.getByRole("button", { name: "Use for this launch" }).click();
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
  await page.evaluate(() =>
    sessionStorage.removeItem("frame-of-mind:studio:intent-draft")
  );

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
    page.getByRole("heading", { name: "Video analysis", level: 1 }),
  ).toBeVisible();
  await expect(page.getByText("video only · no external context")).toBeVisible();
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
