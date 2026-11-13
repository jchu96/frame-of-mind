import { childEnvironment } from "../lib/child-env.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { File as GeminiFile } from "@google/genai";
import { defaultAppDataRoot } from "../lib/paths.js";
import type { ClipClock } from "../domain/clock.js";

const exec = promisify(execFile);
const calibrationSchema = z.strictObject({
  model: z.string().min(1).max(240), checkedAt: z.iso.datetime(),
  result: z.enum(["absolute", "relative", "unverified"]),
  evidence: z.strictObject({ flashFileSeconds: z.literal(27), clipStartSeconds: z.literal(20), reportedSeconds: z.number().finite().nullable() }),
});
export type Calibration = z.infer<typeof calibrationSchema>;
export interface CalibrationAnalyzer {
  readonly model: string;
  upload(path: string, mimeType: string): Promise<GeminiFile>;
  probeClipClock(file: GeminiFile): Promise<number>;
  delete(file: GeminiFile): Promise<void>;
}
export function classifyClipClock(reported: number | null): ClipClock {
  if (reported !== null && Math.abs(reported - 27) <= 2) return "absolute";
  if (reported !== null && Math.abs(reported - 7) <= 2) return "relative";
  return "unverified";
}
export async function synthesizeFlash(path: string): Promise<boolean> {
  try {
    await exec("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=160x90:r=1:d=40", "-vf", "drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='gte(t,27)*lt(t,28)'", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", path], { env: childEnvironment("media"), timeout: 60_000, maxBuffer: 64 * 1024 });
    await chmod(path, 0o600);
    return true;
  } catch { return false; }
}
export async function calibrateClipClock(analyzer: CalibrationAnalyzer, options: {
  cacheRoot?: string; now?: () => number; force?: boolean; synthesize?: typeof synthesizeFlash;
} = {}): Promise<Calibration> {
  const now = (options.now ?? Date.now)();
  const root = options.cacheRoot ?? join(defaultAppDataRoot(), "calibration");
  const cache = join(root, `${encodeURIComponent(analyzer.model)}.json`);
  if (!options.force) {
    try {
      const cached = calibrationSchema.parse(JSON.parse(await readFile(cache, "utf8")));
      const age = now - Date.parse(cached.checkedAt);
      if (cached.model === analyzer.model && age >= 0 && age < 30 * 86400_000
        && cached.result === classifyClipClock(cached.evidence.reportedSeconds)) return cached;
    } catch { /* A missing or invalid measurement must be measured again. */ }
  }
  const directory = await mkdtemp(join(tmpdir(), "frame-of-mind-calibration-"));
  let remote: GeminiFile | undefined;
  let reportedSeconds: number | null = null;
  try {
    const video = join(directory, "flash.mp4");
    if (await (options.synthesize ?? synthesizeFlash)(video)) {
      try {
        remote = await analyzer.upload(video, "video/mp4");
        const answer = await analyzer.probeClipClock(remote);
        if (Number.isFinite(answer)) reportedSeconds = answer;
      } catch { /* Failed measurements never establish a clock. */ }
    }
  } finally {
    try { if (remote) await analyzer.delete(remote); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
  const result = calibrationSchema.parse({ model: analyzer.model, checkedAt: new Date(now).toISOString(), result: classifyClipClock(reportedSeconds), evidence: { flashFileSeconds: 27, clipStartSeconds: 20, reportedSeconds } });
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const temporary = `${cache}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, cache);
  } finally { await rm(temporary, { force: true }); }
  return result;
}
