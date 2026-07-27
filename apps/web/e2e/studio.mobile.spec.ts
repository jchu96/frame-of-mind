import { expect, test } from "@playwright/test";
import { collectClientErrors } from "./support/client-errors";

test("keeps the local Studio usable on a narrow screen", {
  tag: "@smoke",
}, async ({ page }) => {
  const clientErrors = collectClientErrors(page);

  await page.goto("/connections");
  await expect(
    page.getByRole("heading", {
      name: "Connections, without a credential vault.",
    }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "Gemini connection" })).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Primary navigation" }),
  ).toBeVisible();

  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1);

  await page.goto("/recording");
  await expect(
    page.getByRole("heading", { name: "Put one recording in the frame." }),
  ).toBeVisible();
  await expect(
    page.locator('div[data-slot="base"][role="button"]'),
  ).toBeVisible();
  const recordingDimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(recordingDimensions.content).toBeLessThanOrEqual(
    recordingDimensions.viewport + 1,
  );
  expect(clientErrors).toEqual([]);
});
