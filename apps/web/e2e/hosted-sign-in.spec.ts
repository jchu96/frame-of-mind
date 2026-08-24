import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { assertVisibleTextContrast } from "./support/contrast";

const origin = process.env.FRAME_OF_MIND_HOSTED_SIGN_IN_ORIGIN;
const mode = process.env.FRAME_OF_MIND_HOSTED_SIGN_IN_MODE;
const accessToken = process.env.FRAME_OF_MIND_HOSTED_SIGN_IN_ACCESS_TOKEN;

if (!origin || (mode !== "better-auth" && mode !== "cloudflare-access+better-auth")) {
  throw new Error("The hosted sign-in fixture origin and auth mode are required.");
}
if (mode === "cloudflare-access+better-auth" && !accessToken) {
  throw new Error("The stacked hosted sign-in fixture requires an Access token.");
}

test.use({
  baseURL: origin,
  extraHTTPHeaders: accessToken
    ? { "cf-access-jwt-assertion": accessToken }
    : undefined,
});

test.describe(`hosted sign-in (${mode})`, () => {
  test("keeps sign-in text legible in light and dark schemes", async ({ page }) => {
    const screenshotRoot = resolve("apps/web/e2e/__screenshots__/ux-pass-3");
    if (mode === "better-auth") await mkdir(screenshotRoot, { recursive: true });
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await page.goto("/sign-in");
      await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
      await assertVisibleTextContrast(page, `sign-in ${colorScheme}`);
      if (mode !== "better-auth") continue;
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.screenshot({
        path: resolve(screenshotRoot, `14-sign-in-desktop-${colorScheme}.png`),
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({
        path: resolve(screenshotRoot, `14-sign-in-mobile-${colorScheme}.png`),
        fullPage: true,
      });
    }
  });

  test("renders through built middleware and discriminates HTML from API denial", async ({ page, request }) => {
    const signInResponse = await page.goto("/sign-in");
    expect(signInResponse?.status()).toBe(200);
    await expect(page.getByRole("button", { name: "Continue with GitHub" })).toBeVisible();

    const htmlResponse = await request.get("/", {
      headers: { accept: "text/html" },
      maxRedirects: 0,
    });
    expect(htmlResponse.status()).toBe(302);
    expect(htmlResponse.headers().location).toBe("/sign-in?next=%2F");

    const apiResponse = await request.get("/api/session", {
      headers: { accept: "application/json" },
      maxRedirects: 0,
    });
    expect(apiResponse.status()).toBe(403);
    expect(await apiResponse.json()).toMatchObject({
      data: { code: "better_auth_session_missing" },
    });

    const iconResponse = await request.get(
      "/api/_nuxt_icon/lucide.json?icons=mail-check",
      { maxRedirects: 0 },
    );
    expect(iconResponse.status()).toBe(200);

    const iconTraversalResponse = await request.get(
      "/api/_nuxt_icon/..%2fapi/session?icons=mail-check",
      { maxRedirects: 0 },
    );
    expect(iconTraversalResponse.status()).toBe(403);
  });

  for (const [label, requestedNext, expectedPath] of [
    ["rejects an external next target", "https://evil.example", "/"],
    ["keeps a relative next target", "/runs/abc", "/runs/abc"],
  ] as const) {
    test(label, async ({ page }) => {
      await page.goto(`/sign-in?next=${encodeURIComponent(requestedNext)}`);
      await page.getByRole("button", { name: "Continue with GitHub" }).click();
      await page.waitForURL((url) => url.origin === origin && url.pathname === expectedPath);
      expect(new URL(page.url()).origin).toBe(origin);
    });
  }

  test("redirects a signed-in visitor away from sign-in", async ({ page }) => {
    await page.goto("/sign-in");
    await page.getByRole("button", { name: "Continue with GitHub" }).click();
    await page.waitForURL((url) => url.origin === origin && url.pathname === "/");
    await page.goto("/sign-in");
    await page.waitForURL((url) => url.origin === origin && url.pathname === "/");
  });

  test("signs out and removes the authenticated session", async ({ page }) => {
    await page.goto("/sign-in");
    await page.getByRole("button", { name: "Continue with GitHub" }).click();
    await page.waitForURL((url) => url.origin === origin && url.pathname === "/");
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForURL((url) => url.origin === origin && url.pathname === "/sign-in");

    const sessionResponse = await page.request.get("/api/session", {
      headers: { accept: "application/json" },
      maxRedirects: 0,
    });
    expect(sessionResponse.status()).toBe(403);
    expect(await sessionResponse.json()).toMatchObject({
      data: { code: "better_auth_session_missing" },
    });
  });

  test("keeps the session visible when sign-out fails", async ({ page }) => {
    await page.goto("/sign-in");
    await page.getByRole("button", { name: "Continue with GitHub" }).click();
    await page.waitForURL((url) => url.origin === origin && url.pathname === "/");
    await page.route("**/api/auth/sign-out", async (route) => {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ code: "SIGN_OUT_UNAVAILABLE" }),
      });
    });
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByText("Could not sign out", { exact: true })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/");
  });

  test("renders friendly email sign-in failures", async ({ page }) => {
    await page.goto("/sign-in");
    await page.route("**/api/auth/sign-in/magic-link", async (route) => {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ code: "MAILER_UNAVAILABLE" }),
      });
    });
    await page.getByRole("textbox", { name: "Email address" }).fill("browser@example.test");
    await page.getByRole("button", { name: "Email me a sign-in link" }).click();
    await expect(page.getByText("Email sign-in is not enabled on this deployment.")).toBeVisible();

    await page.unroute("**/api/auth/sign-in/magic-link");
    await page.goto("/sign-in?error=EMAIL_NOT_INVITED");
    await expect(page.getByText(
      "Email sign-in is available after your access is approved. Continue with GitHub to request access.",
    )).toBeVisible();

    await page.route("**/api/auth/sign-in/magic-link", async (route) => {
      await route.fulfill({
        status: 429,
        contentType: "application/json",
        body: JSON.stringify({ code: "MAGIC_LINK_COOLDOWN" }),
      });
    });
    await page.getByRole("textbox", { name: "Email address" }).fill("browser@example.test");
    await page.getByRole("button", { name: "Email me a sign-in link" }).click();
    await expect(page.getByText(
      "A sign-in link was sent recently. Check your inbox or try again in a minute.",
    )).toBeVisible();
  });
});
