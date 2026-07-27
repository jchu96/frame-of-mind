import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { File as GeminiFile } from "@google/genai";
import { GeminiVideoAnalyzer } from "../src/adapters/gemini.js";
import type {
  AnalysisRecipe,
  MeetingEvidence,
} from "../src/domain/types.js";
import { timestampToSeconds } from "../src/lib/time.js";

const SYNTHETIC_DURATION_SECONDS = 12;
const apiKey = process.env.GEMINI_API_KEY?.trim();
if (!apiKey) {
  throw new Error(
    "GEMINI_API_KEY is required. Export it locally; never pass it as a command argument.",
  );
}

const smokeDirectory = await mkdtemp(join(tmpdir(), "frame-of-mind-gemini-"));
const videoPath = join(smokeDirectory, "synthetic.mp4");
const analyzer = new GeminiVideoAnalyzer(apiKey);
let remote: GeminiFile | undefined;
let cleanupError: unknown;

const meeting: MeetingEvidence = {
  id: "synthetic-gemini-smoke",
  provider: "file",
  transport: "file",
  title: "Synthetic Gemini compatibility smoke",
  transcript:
    "[00:00:01] Synthetic narrator: This generated recording tests video understanding and cleanup.",
  raw: {},
};

const recipe: AnalysisRecipe = {
  id: "synthetic-smoke",
  label: "Synthetic compatibility smoke",
  description:
    "Confirm that generated video can produce schema-valid structured output.",
  indexInstruction:
    "This synthetic recording is exactly 12 seconds. Find a visible color-pattern change wholly within 00:00:00 through 00:00:12 and use kind compatibility-smoke.",
  interrogationInstruction:
    "Describe only the generated color pattern. When accepted, use kind compatibility-smoke. Set accepted=false if the clip lacks enough evidence.",
};

try {
  console.log("Gemini smoke: generating synthetic video");
  await generateSyntheticVideo(videoPath);

  console.log("Gemini smoke: uploading");
  remote = await analyzer.upload(videoPath, "video/mp4");

  console.log("Gemini smoke: validating index schema");
  const index = await analyzer.index(
    remote,
    meeting,
    recipe,
    "Synthetic compatibility only; every candidate must stay within the exact 12-second recording.",
  );
  const candidate = index.moments.find((moment) =>
    timestampToSeconds(moment.start) >= 0
    && timestampToSeconds(moment.end) <= SYNTHETIC_DURATION_SECONDS
    && moment.kind === "compatibility-smoke"
  );
  if (!index.isRelevantCall || !candidate) {
    throw new Error(
      "Gemini smoke index did not identify an in-bounds generated test moment.",
    );
  }

  console.log("Gemini smoke: validating detail schema");
  const detail = await analyzer.interrogate(
    remote,
    candidate,
    meeting.transcript,
    recipe,
    "Synthetic compatibility only.",
  );
  const evidenceSeconds = detail.evidence?.timestamp
    ? timestampToSeconds(detail.evidence.timestamp)
    : undefined;
  if (
    !detail.accepted
    || detail.kind !== "compatibility-smoke"
    || evidenceSeconds === undefined
    || evidenceSeconds < timestampToSeconds(candidate.start)
    || evidenceSeconds > timestampToSeconds(candidate.end)
  ) {
    throw new Error(
      "Gemini smoke detail did not return accepted, timestamped in-bounds evidence.",
    );
  }

  console.log("Gemini smoke: passed");
} finally {
  if (remote) {
    try {
      console.log("Gemini smoke: deleting remote file");
      await deleteRemoteWithRetry(analyzer, remote);
    } catch (error) {
      cleanupError = error;
    }
  }
  await rm(smokeDirectory, { recursive: true, force: true });
  if (cleanupError) {
    throw new Error(
      "Gemini smoke completed, but remote cleanup could not be confirmed.",
    );
  }
}

async function generateSyntheticVideo(path: string): Promise<void> {
  const process = Bun.spawn([
    "ffmpeg",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x180:rate=12",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=16000",
    "-t",
    String(SYNTHETIC_DURATION_SECONDS),
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-map_metadata",
    "-1",
    "-y",
    path,
  ], {
    stdout: "ignore",
    stderr: "pipe",
    env: minimalProcessEnvironment(),
  });
  const stderr = await new Response(process.stderr).text();
  const exitCode = await process.exited;
  if (exitCode !== 0) {
    throw new Error(
      `ffmpeg could not generate the synthetic smoke video (exit ${exitCode}): ${stderr.trim()}`,
    );
  }
}

async function deleteRemoteWithRetry(
  analyzer: GeminiVideoAnalyzer,
  remote: GeminiFile,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await analyzer.delete(remote);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        await new Promise((resolve) =>
          setTimeout(resolve, 250 * (attempt + 1))
        );
      }
    }
  }
  throw lastError;
}

function minimalProcessEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of ["PATH", "TMPDIR", "TEMP", "TMP", "SystemRoot"]) {
    const value = process.env[name];
    if (value) environment[name] = value;
  }
  return environment;
}
