import { expect, test } from "@playwright/test";

test("protected Studio surfaces fail closed without a session", {
  tag: "@smoke",
}, async ({ request }) => {
  const pageResponse = await request.get("/connections", {
    maxRedirects: 0,
  });
  expect(pageResponse.status()).toBe(401);

  const apiResponse = await request.get("/api/studio/configuration", {
    maxRedirects: 0,
  });
  expect(apiResponse.status()).toBe(401);
  expect(await apiResponse.text()).not.toContain("provider");
});
