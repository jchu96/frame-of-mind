import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { program } from "../src/cli-main.js";
import * as mediaCapabilities from "../src/services/media-capabilities.js";
import * as mediaTools from "../src/services/media-tools.js";

it("reports both tool builds and refuses a missing H.264 encoder before opening the source", async () => {
  const root = await mkdtemp(join(tmpdir(), "doctor-tools-"));
  const previous = process.exitCode;
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const report = () => stdout.mock.calls.map(([chunk]) => String(chunk)).join("");
  try {
    // A synthetic configured flag keeps the existing required-key check green.
    vi.stubEnv("GEMINI_API_KEY", "fixture");
    vi.stubEnv("PATH", root);
    const log = join(root, "calls");
    const standIn = `#!/bin/sh
tool=\${0##*/}
flag=$0
for flag do :; done
printf '%s %s\\n' "$tool" "$flag" >> "\${0%/*}/calls"
case "$flag" in
  -version) printf '%s version fixture\\n' "$tool" ;;
  -encoders) printf '%s\\n' ' V..... wrapped_avframe wrapped video' ' A..... pcm_s16le audio' ' A..... aac audio' ;;
  -filters)
    for filter in trim setpts fps scale anullsrc atrim aresample aformat asetpts amix color drawbox; do
      printf ' ... %s V->V description\\n' "$filter"
    done ;;
  -formats) printf '%s\\n' ' D   mov,mp4,m4a container' ' D d lavfi device' '  E  mp4 output' '  E  null output' ;;
  *) exit 2 ;;
esac
`;
    for (const name of ["ffmpeg", "ffprobe"]) await writeFile(join(root, name), standIn, {mode: 0o700});
    const {mediaCapabilityReport} = mediaCapabilities;
    vi.spyOn(mediaCapabilities, "mediaCapabilityReport").mockImplementation(() => mediaCapabilityReport(30_000));
    const doctor = () => program.parseAsync(["doctor"], {from: "user"});
    process.exitCode = 0;
    await doctor();
    expect(process.exitCode).toBe(0);
    expect(report()).toContain("ffmpeg version fixture");
    expect(report()).toContain("ffprobe version fixture");
    for (const name of ["proxy", "slice", "calibrate"]) {
      const row = report().split("\n").find(line => line.startsWith(name + " "));
      expect(row).toMatch(/Missing encoder:libx264\./);
    }
    expect(report()).toMatch(/probe needs .*Ready\./);
    const proxyListings = vi.spyOn(mediaTools, "runMediaTool");
    await expect(program.parseAsync(["proxy", join(root, "absent.mp4"), "-o", join(root, "out.mp4")], {from: "user"}))
      .rejects.toThrow(/proxy.*missing.*encoder:libx264/);
    expect(new Set(proxyListings.mock.calls.map(([, , options]) => options?.timeoutMs))).toEqual(new Set([5000]));
    const calls = new Set((await readFile(log, "utf8")).trim().split("\n"));
    expect(calls).toEqual(new Set(["ffmpeg", "ffprobe"].flatMap(tool =>
      ["-version", "-encoders", "-filters", "-formats"].map(flag => tool + " " + flag))));
    await rm(join(root, "ffmpeg"));
    stdout.mockClear();
    await doctor();
    expect(report()).toContain("ffmpeg not installed");
    expect(process.exitCode).toBe(0);
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.exitCode = previous;
    await rm(root, {recursive: true, force: true});
  }
}, 30_000);
