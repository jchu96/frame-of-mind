import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import { MEDIA_RESUME_STORAGE_KEY } from "../../server-local/studio-ui/media-upload";
import { collectClientErrors } from "../support/client-errors";

function syntheticMp4(bytes: number): Buffer {
  const fixture = Buffer.alloc(bytes);
  fixture.writeUInt32BE(24, 0);
  fixture.write("ftypisom", 4, "ascii");
  for (let index = 12; index < fixture.length; index += 1) {
    fixture[index] = index % 251;
  }
  return fixture;
}

function fileFingerprint(bytes: Buffer, partSizeBytes = 8 * 1_024 * 1_024): string {
  const partDigests: string[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += partSizeBytes) {
    partDigests.push(createHash("sha256")
      .update(bytes.subarray(offset, Math.min(offset + partSizeBytes, bytes.byteLength)))
      .digest("hex"));
  }
  return createHash("sha256").update(partDigests.join("")).digest("hex");
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
      fileFingerprintSha256: fileFingerprint(recording),
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
    page.getByText("8,388,608 of 8,388,672 bytes", { exact: false }),
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
    page.getByText("8,388,672 of 8,388,672 bytes", { exact: false }),
  ).toBeVisible();

  await page.getByRole("link", { name: "Continue to context" }).click();
  await expect(page).toHaveURL(/\/context$/);
  await expect(
    page.getByRole("heading", {
      name: "Pair the recording with what was said.",
    }),
  ).toBeVisible();

  await page.getByLabel("Local context").check();
  await page.getByLabel("Context file").setInputFiles({
    name: "synthetic-context.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# Synthetic context\n\nNo private meeting data."),
  });
  await expect(page.getByText("# Synthetic context")).toBeVisible();
  await page.getByRole("button", { name: "Stage context locally" }).click();
  await expect(page.getByText("markdown", { exact: true })).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Delete staged context" }),
  ).toBeVisible();
  await expect(page.getByText("Context step saved")).toHaveCount(0);

  const alignmentDisclosure = page.locator("details").filter({
    hasText: "Advanced transcript alignment",
  });
  await alignmentDisclosure.locator("summary").click();
  await page.getByLabel("Transcript time at recording 00:00:00")
    .fill("01:02:03");
  await page.getByRole("button", { name: "Save context step" }).click();
  await expect(page.getByText("Context step saved")).toBeVisible();
  await page.reload();
  await expect(page.getByText("Context step saved")).toBeVisible();
  await alignmentDisclosure.locator("summary").click();
  await expect(alignmentDisclosure).toHaveAttribute("open", "");
  await expect(
    page.getByLabel("Transcript time at recording 00:00:00"),
  ).toHaveValue("01:02:03");
  await page.getByRole("button", { name: "Delete staged context" }).click();

  await page.getByRole("link", { name: "Back to recording" }).click();
  await page.getByRole("button", { name: "Delete staged copy" }).click();
  await expect(page.getByText("Staged recording deleted.")).toBeVisible();
  expect(clientErrors).toEqual([]);
});
