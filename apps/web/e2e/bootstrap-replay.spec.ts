import { expect, test } from "@playwright/test";
import {
  LOCAL_STUDIO_BOOTSTRAP_FRAGMENT,
  LOCAL_STUDIO_BOOTSTRAP_PATH,
} from "../server-local/studio-session/contract";
import { E2E_BOOTSTRAP_TOKEN } from "./support/constants";
import { collectClientErrors } from "./support/client-errors";

test("the one-time launch fragment cannot be replayed", async ({ page }) => {
  const clientErrors = collectClientErrors(page, {
    ignoreConsoleError: (message) =>
      message.includes("403")
      && message.includes("Bootstrap capability is invalid or already used."),
  });
  const rejectedExchange = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === LOCAL_STUDIO_BOOTSTRAP_PATH
      && response.request().method() === "POST";
  });

  await page.goto(
    `/${LOCAL_STUDIO_BOOTSTRAP_FRAGMENT}${encodeURIComponent(E2E_BOOTSTRAP_TOKEN)}`,
  );

  expect((await rejectedExchange).status()).toBe(403);
  await page.waitForURL((url) => url.pathname === "/" && url.hash === "");
  await expect(
    page.getByRole("heading", { name: "Find the signal after the call." }),
  ).toBeVisible();
  expect(new URL(page.url()).hash).toBe("");

  const sessionResponse = await page.request.get("/api/studio/session");
  expect(sessionResponse.status()).toBe(401);
  expect(clientErrors).toEqual([]);
});
