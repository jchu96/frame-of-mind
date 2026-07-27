import { expect, test } from "@playwright/test";
import { MEDIA_RESUME_STORAGE_KEY } from "../server-local/studio-ui/media-upload";
import { collectClientErrors } from "./support/client-errors";

function syntheticMp4(bytes: number): Buffer {
  const fixture = Buffer.alloc(bytes);
  fixture.writeUInt32BE(24, 0);
  fixture.write("ftypisom", 4, "ascii");
  for (let index = 12; index < fixture.length; index += 1) {
    fixture[index] = index % 251;
  }
  return fixture;
}

test("reconciles an unfinished upload and resumes only after file re-selection", async ({
  page,
}) => {
  const clientErrors = collectClientErrors(page);
  const recording = syntheticMp4(8 * 1_024 * 1_024 + 64);
  const createResponse = await page.request.post("/api/studio/media", {
    data: {
      idempotencyKey: "e2e-browser-resume-0001",
      expectedBytes: recording.byteLength,
      mimeType: "video/mp4",
      retention: { mode: "ephemeral" },
    },
  });
  expect(createResponse.status()).toBe(201);
  const created = await createResponse.json() as {
    id: string;
    partSizeBytes: number;
  };

  const firstPartResponse = await page.request.put(
    `/api/studio/media/${created.id}/parts/0`,
    {
      data: recording.subarray(0, created.partSizeBytes),
      headers: {
        "content-type": "video/mp4",
        "upload-offset": "0",
      },
    },
  );
  expect(firstPartResponse.status()).toBe(200);

  await page.goto("/recording");
  await page.evaluate(({ key, id }) => {
    sessionStorage.setItem(key, JSON.stringify({
      schemaVersion: 1,
      mediaSessionId: id,
    }));
  }, { key: MEDIA_RESUME_STORAGE_KEY, id: created.id });
  await page.reload();

  await expect(
    page.getByText("An unfinished upload was found.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("8.0 MB of 8.0 MB confirmed locally"),
  ).toBeVisible();

  await page.getByLabel("Screen recording").setInputFiles({
    name: "resume-walkthrough.mp4",
    mimeType: "video/mp4",
    buffer: recording,
  });
  await expect(
    page.getByText("Recording metadata matches.", { exact: false }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(
    page.getByText("Recording staged and sealed locally."),
  ).toBeVisible();
  await expect(
    page.getByText("8.0 MB of 8.0 MB confirmed locally"),
  ).toBeVisible();

  await page.getByRole("button", { name: "Delete staged copy" }).click();
  await expect(page.getByText("Staged recording deleted.")).toBeVisible();
  expect(clientErrors).toEqual([]);
});
