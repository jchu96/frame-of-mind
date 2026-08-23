import { test, expect } from "../support/hosted-test";

// REVIEW-fom-phase4.md: foreign attempt/root/media/run IDs and foreign-media
// create paths must all collapse to 404 for the requesting principal.
test("@adversarial every hosted ID route hides principal A from principal B", async ({
  hosted,
}) => {
  const a = await hosted.session("a");
  const b = await hosted.session("b");
  const created = await fetch(`${hosted.baseUrl}/api/hosted/jobs`, {
    method: "POST",
    headers: mutationHeaders(hosted.baseUrl, a.headers),
    body: JSON.stringify({
      idempotencyKey: `adversarial-owner-${crypto.randomUUID()}`,
      mediaId: hosted.media.a,
      context: { mode: "none" },
      recipeId: "decisions",
    }),
  });
  expect(created.status).toBe(201);
  const owned = await created.json() as {
    job: { id: string; rootJobId: string; runId?: string; stage: string };
  };

  let runId = "";
  await expect.poll(async () => {
    const response = await fetch(
      `${hosted.baseUrl}/api/hosted/jobs/${encodeURIComponent(owned.job.id)}`,
      { headers: a.headers },
    );
    const detail = await response.json() as {
      job: { stage: string; runId?: string };
    };
    runId = detail.job.runId || "";
    return detail.job.stage;
  }, { timeout: 60_000 }).toBe("succeeded");

  const foreignGets = [
    `/api/hosted/media/${hosted.media.a}`,
    `/api/hosted/jobs/${owned.job.id}`,
    `/api/hosted/jobs/${owned.job.rootJobId}`,
    `/api/runs/${runId}`,
    `/hosted/activity/${owned.job.id}`,
  ];
  for (const path of foreignGets) {
    const response = await fetch(`${hosted.baseUrl}${path}`, {
      headers: b.headers,
      redirect: "manual",
    });
    expect(response.status, path).toBe(404);
  }
  const foreignList = await fetch(`${hosted.baseUrl}/api/hosted/jobs`, {
    headers: b.headers,
  });
  expect(foreignList.status).toBe(200);
  expect((await foreignList.json() as { jobs: unknown[] }).jobs).toEqual([]);

  for (const path of [
    `/api/hosted/jobs/${owned.job.id}/retry`,
  ]) {
    const response = await fetch(`${hosted.baseUrl}${path}`, {
      method: "POST",
      headers: mutationHeaders(hosted.baseUrl, b.headers),
      body: JSON.stringify(path.endsWith("/retry")
        ? { idempotencyKey: `foreign-retry-${crypto.randomUUID()}` }
        : {}),
    });
    expect(response.status, path).toBe(404);
  }

  // Named fixture for the sealed_media_receipt_missing -> 404 regression.
  for (const [path, body] of [
    ["/api/hosted/jobs", {
      idempotencyKey: `foreign-media-create-${crypto.randomUUID()}`,
      mediaId: hosted.media.a,
      context: { mode: "none" },
      recipeId: "decisions",
    }],
    ["/api/hosted/composer/jobs", {
      idempotencyKey: `foreign-media-composer-${crypto.randomUUID()}`,
      mediaSessionId: hosted.media.a,
      context: { mode: "none" },
      recipe: { id: "decisions", revision: "builtin-2026-08-11.1" },
      model: "gemini-3.7-flash",
      retention: { mode: "retained", ttlSeconds: 604800 },
    }],
  ] as const) {
    const response = await fetch(`${hosted.baseUrl}${path}`, {
      method: "POST",
      headers: mutationHeaders(hosted.baseUrl, b.headers),
      body: JSON.stringify(body),
    });
    expect(response.status, `${path} foreign-media fixture`).toBe(404);
  }
});

// REVIEW-fom-slice1.md: service identities are non-browser principals.
test("@adversarial service token receives 403 on browser data routes", async ({
  hosted,
}) => {
  const service = await hosted.session("service");
  for (const path of ["/api/runs", "/api/hosted/jobs", "/api/session"]) {
    const response = await fetch(`${hosted.baseUrl}${path}`, {
      headers: service.headers,
      redirect: "manual",
    });
    const expected = path === "/api/session" ? 200 : 403;
    expect(response.status, path).toBe(expected);
  }
});

function mutationHeaders(
  origin: string,
  auth: Record<string, string>,
): Record<string, string> {
  return { ...auth, origin, "content-type": "application/json" };
}
