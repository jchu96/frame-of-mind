import { expect, test } from "@playwright/test";
import { LOCAL_STUDIO_BOOTSTRAP_FRAGMENT } from "../server-local/studio-session/contract";
import { E2E_BOOTSTRAP_TOKEN } from "./support/constants";

test("the one-time launch fragment cannot be replayed", async ({ page }) => {
  await page.goto(
    `/${LOCAL_STUDIO_BOOTSTRAP_FRAGMENT}${encodeURIComponent(E2E_BOOTSTRAP_TOKEN)}`,
  );

  await page.waitForURL((url) => url.pathname === "/" && url.hash === "");
  await expect(
    page.getByRole("heading", { name: "Find the signal after the call." }),
  ).toBeVisible();
  expect(new URL(page.url()).hash).toBe("");

  const sessionResponse = await page.request.get("/api/studio/session");
  expect(sessionResponse.status()).toBe(401);
});
