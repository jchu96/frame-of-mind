import { expect, test } from "@playwright/test";

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
    await expect(page.getByText("This email has not been invited to Frame of Mind.")).toBeVisible();
  });
});
