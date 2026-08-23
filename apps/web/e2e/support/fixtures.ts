import { analysisDigest } from "../../../../src/domain/integrity";
import { runFixture, videoRunFixture } from "../../test/fixtures";

export const adversarialStrings = Object.freeze({
  transcript: "Synthetic transcript text must not leave the fixture boundary.",
  posixPath: "/private/synthetic/recording.mp4",
  windowsPath: "C:\\private\\synthetic\\recording.mp4",
  signedUrl: "https://example.test/media?X-Amz-Signature=fixture-only",
  oauthToken: "fixture-only-oauth-token-never-valid",
  email: "private-person@example.test",
  providerError: "fixture provider payload must not be rendered",
});

export function sealedMediaReceipt(
  principal: "a" | "b",
): {
  id: string;
  sha256: string;
  retention: { mode: "retained"; expiresAt: string };
} {
  return {
    id: `media_e2e_principal_${principal}_0001`,
    sha256: "a".repeat(64),
    retention: {
      mode: "retained",
      expiresAt: new Date(Date.now() + 6 * 86_400_000).toISOString(),
    },
  };
}

export async function runPair(
  principal: "a" | "b",
): Promise<Awaited<ReturnType<typeof videoRunFixture>>> {
  const pair = principal === "a" ? await videoRunFixture() : runFixture();
  const runId = `20260823T12000${principal === "a" ? "1" : "2"}Z-e2e-${principal}`;
  pair.analysis.runId = runId;
  pair.manifest.runId = runId;
  pair.manifest.analysisSha256 = await analysisDigest(pair.analysis);
  return pair as Awaited<ReturnType<typeof videoRunFixture>>;
}
