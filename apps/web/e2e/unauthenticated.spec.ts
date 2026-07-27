import { expect, test } from "@playwright/test";

test("protected Studio surfaces fail closed without a session", {
  tag: "@smoke",
}, async ({ request }) => {
  const homeResponse = await request.get("/", {
    maxRedirects: 0,
  });
  expect(homeResponse.status()).toBe(401);

  const pageResponse = await request.get("/connections", {
    maxRedirects: 0,
  });
  expect(pageResponse.status()).toBe(401);

  const runResponse = await request.get("/api/runs", {
    maxRedirects: 0,
  });
  expect(runResponse.status()).toBe(401);

  const apiResponse = await request.get("/api/studio/configuration", {
    maxRedirects: 0,
  });
  expect(apiResponse.status()).toBe(401);
  expect(await apiResponse.text()).not.toContain("provider");

  const launchResponse = await request.get("/__studio/launch", {
    maxRedirects: 0,
  });
  expect(launchResponse.status()).toBe(200);
  expect(await launchResponse.text()).toContain("Opening private Studio");
});
