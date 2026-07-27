import { expect, test } from "@playwright/test";
import { runFixture } from "../test/fixtures";
import { collectClientErrors } from "./support/client-errors";

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

  await page.getByRole("link", { name: "Runs", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Product review", exact: true }),
  ).toBeVisible();
  expect(clientErrors).toEqual([]);
});
