import { request as playwrightRequest, test, expect } from "@playwright/test";

const canaryUrl = process.env.FRAME_OF_MIND_CANARY_URL?.replace(/\/$/, "");
const clientId = process.env.CF_ACCESS_CLIENT_ID;
const clientSecret = process.env.CF_ACCESS_CLIENT_SECRET;

test("deployed canary is Access-protected, healthy, and dark", async () => {
  if (!canaryUrl || !clientId || !clientSecret) {
    console.log(
      "CANARY environment=SKIP FRAME_OF_MIND_CANARY_URL and CF_ACCESS_CLIENT_ID/SECRET are required",
    );
    test.skip();
  }
  const unauthenticated = await playwrightRequest.newContext();
  const service = await playwrightRequest.newContext({
    extraHTTPHeaders: {
      "CF-Access-Client-Id": clientId!,
      "CF-Access-Client-Secret": clientSecret!,
    },
  });
  try {
    await check("unauth_302", async () => {
      const response = await unauthenticated.get(`${canaryUrl}/`, {
        maxRedirects: 0,
      });
      expect(response.status()).toBe(302);
    });
    await check("service_runs_403", async () => {
      const response = await service.get(`${canaryUrl}/api/runs`, {
        maxRedirects: 0,
      });
      expect(response.status()).toBe(403);
    });
    await check("session_shape", async () => {
      const response = await service.get(`${canaryUrl}/api/session`);
      expect(response.status()).toBe(200);
      const body = await response.json() as Record<string, unknown>;
      expect(body.authMode).toBe("cloudflare-access");
      expect(body).not.toHaveProperty("principal");
      expect(body).not.toHaveProperty("sub");
    });
    await check("hosted_dark", async () => {
      for (const path of ["/hosted/new/intent", "/hosted/activity"]) {
        const response = await service.get(`${canaryUrl}${path}`, {
          maxRedirects: 0,
        });
        expect(response.status(), path).toBe(404);
      }
    });
    await check("health", async () => {
      const response = await service.get(`${canaryUrl}/api/health`);
      expect(response.status()).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true });
    });
    await check("static_assets", async () => {
      const response = await service.get(`${canaryUrl}/favicon.svg`);
      expect(response.status()).toBe(200);
      expect(response.headers()["content-type"]).toContain("image/svg+xml");
    });
  } finally {
    await unauthenticated.dispose();
    await service.dispose();
  }
});

async function check(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
    console.log(`CANARY ${name}=PASS`);
  } catch (error) {
    console.log(`CANARY ${name}=FAIL`);
    throw error;
  }
}
