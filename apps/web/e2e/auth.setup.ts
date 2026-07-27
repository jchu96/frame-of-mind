import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { expect, test as setup } from "@playwright/test";
import {
  LOCAL_STUDIO_BOOTSTRAP_FRAGMENT,
  LOCAL_STUDIO_COOKIE_NAME,
  LOCAL_STUDIO_LAUNCH_PATH,
} from "../server-local/studio-session/contract";
import {
  E2E_BOOTSTRAP_TOKEN,
  E2E_STORAGE_STATE,
} from "./support/constants";
import { collectClientErrors } from "./support/client-errors";

setup("exchanges the one-time launch fragment for a local session", {
  tag: "@smoke",
}, async ({ page }) => {
  const clientErrors = collectClientErrors(page);
  expect(process.env.FRAME_OF_MIND_E2E_SECRET_CANARY).toBeUndefined();
  expect(process.env.GEMINI_API_KEY).toBeUndefined();
  await rm(E2E_STORAGE_STATE, { force: true });

  await setup.step("exchange and clean the launch URL", async () => {
    await page.goto(
      `${LOCAL_STUDIO_LAUNCH_PATH}${LOCAL_STUDIO_BOOTSTRAP_FRAGMENT}`
      + encodeURIComponent(E2E_BOOTSTRAP_TOKEN),
    );
    await page.waitForURL("**/connections");

    await expect(
      page.getByRole("heading", {
        name: "Connections, without a credential vault.",
      }),
    ).toBeVisible();
    expect(new URL(page.url()).hash).toBe("");
  });

  await setup.step("verify and save the browser session", async () => {
    const sessionCookie = (await page.context().cookies()).find(
      (cookie) => cookie.name === LOCAL_STUDIO_COOKIE_NAME,
    );
    expect(sessionCookie).toMatchObject({
      httpOnly: true,
      sameSite: "Strict",
      secure: false,
    });
    expect(await page.evaluate(() => document.cookie)).not.toContain(
      LOCAL_STUDIO_COOKIE_NAME,
    );

    await mkdir(dirname(E2E_STORAGE_STATE), { recursive: true });
    await page.context().storageState({ path: E2E_STORAGE_STATE });
  });

  expect(clientErrors).toEqual([]);
});
