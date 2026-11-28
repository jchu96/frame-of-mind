import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ts from "typescript";
import { afterAll, beforeAll, expect, it } from "vitest";
import { childEnvironment } from "../src/lib/child-env.js";

const entry = resolve("src/cli.ts");
const root = mkdtempSync(join(tmpdir(), "usage-reasons-"));
const analyze = ["analyze", "--source", "none", "--video", "clip.mp4"];
const job = ["analyze", "dry-run", "clip.mp4", "--out", root, "--recipe", "decisions"];
const grant = ["--max-media-seconds", "2", "--max-file-bytes", "1000", "--max-provider-requests", "1",
  "--allowed-models", "gemini-fixture", "--retention", "run"];
function jobWith(flag: string, value: string) {
  const flags = [...grant];
  flags[flags.indexOf(flag) + 1] = value;
  return [...job, ...flags];
}

type Row = { reason: string; args: string[]; plainExit?: number; jsonArgs?: string[]; timing?: boolean };
const row = (reason: string, args: string[], plainExit = 2): Row => ({reason, args, plainExit});
const rows: Row[] = [
  row("remove-requires-scratch", ["doctor", "--remove", "private-example"]),
  row("invalid-model", ["calibrate", "--model", "private-example"]),
  row("unknown-option", ["recipes", "--private-example"]),
  row("unknown-command", ["private-example"]),
  row("missing-argument", ["transcribe"]),
  row("missing-required-option", ["analyze", "private-example.mp4", "--recipe", "decisions"]),
  {reason: "missing-option-value", args: ["doctor", "--remove"], jsonArgs: ["doctor", "--json", "--remove"]},
  row("invalid-argument", [...analyze, "--thinking-level", "private-example"]),
  row("excess-arguments", ["recipes", "private-example"]),
  // No command without --json displays help as a failure. With --json the root rejects the option.
  row("unknown-option", []),
  // Machine-only validations. The plain invocation follows its own parser or action.
  row("invalid-schema-version", ["recipes", "--schema-version=bad"]),
  row("duplicate-schema-version", ["recipes", "--schema-version=1", "--schema-version=1"]),
  row("version-arguments", ["--version", "extra"], 0),
  row("help-with-json", ["--help"], 0),
  row("mcp-with-json", ["mcp", "--help"], 0),
  row("force-with-json", ["transcribe", "nonexistent.mp4", "--force"], 1),
  row("json-output-not-selected", ["doctor", "--remove"]),
  row("duplicate-job-option", [...job, "--out", root]),
  // Job subcommands require --json. The plain parser reports that missing option.
  row("invalid-job-limit", jobWith("--max-provider-requests", "zero")),
  row("invalid-file-limit", jobWith("--max-file-bytes", "2000000001")),
  row("invalid-retention", jobWith("--retention", "private-example")),
  row("invalid-allowed-models", jobWith("--allowed-models", "private-example")),
  row("missing-job-roots", [...job, ...grant]),
  row("conflicting-job-roots", [...job, ...grant, "--roots-file", "roots", "--media-root", root]),
  row("invalid-edge", ["snap", "clip.mp4", "--at", "0", "--edge", "private-example"]),
  row("invalid-file-clock", ["snap", "clip.mp4", "--at", "0", "--edge", "end", "--file-clock", "private-example"]),
  row("verify-expectation", ["verify", "clip.mp4"]),
  row("missing-output", ["proxy", "clip.mp4", "--output="]),
  row("invalid-map-direction", ["map", "sequence.otio"]),
  row("missing-drop-frame-mode", ["map", "sequence.otio", "--at", "00:00:00:01"]),
  row("missing-timeline-offset", [...analyze, "--timecode-rate", "25:ndf"]),
  row("missing-timecode-rate", [...analyze, "--timeline-offset", "2f"]),
  row("invalid-model", ["transcribe", "clip.mp4", "--model", "private-example"]),
  row("invalid-retention", ["transcribe", "clip.mp4", "--retention", "private-example"]),
  row("conflicting-retention", ["transcribe", "clip.mp4", "--delete-upload", "--keep-upload"]),
  row("invalid-transcript-language", ["transcribe", "clip.mp4", "--transcript-language", "@@@"]),
  row("invalid-snap", [...analyze, "--snap", "private-example"]),
  row("invalid-snap-gap", [...analyze, "--snap-gap-ms", "1"]),
  row("invalid-snap-window", [...analyze, "--snap-window-ms", "1"]),
  row("conflicting-transcript-language", [...analyze, "--transcript-language", "en", "--no-derived-transcript"]),
  row("invalid-transcript-language", [...analyze, "--transcript-language", "@@@"]),
  row("invalid-retention", [...analyze, "--retention", "private-example"]),
  row("conflicting-retention", [...analyze, "--retention", "run", "--keep-upload"]),
  row("too-many-notes", [...analyze, ...Array.from({length: 9}, () => ["--note", "a=a.md"]).flat()]),
  row("invalid-note", [...analyze, "--note", "private-example"]),
  row("duplicate-note", [...analyze, "--note", "a=a.md", "--note", "a=b.md"]),
  row("invalid-note-format", [...analyze, "--note", "n=f.bin"]),
  row("invalid-note-file", [...analyze, "--note", "n=folder.md"]),
  row("note-too-large", [...analyze, "--note", "n=large.md"]),
  row("invalid-note-encoding", [...analyze, "--note", "n=encoding.md"]),
  row("binary-note", [...analyze, "--note", "n=binary.md"]),
  row("invalid-label", [...analyze, "--label", " "]),
  row("invalid-recipe-file", [...analyze, "--recipe-file", "broken.json"]),
  row("invalid-depth", [...analyze, "--depth", "private-example"]),
  row("invalid-model", [...analyze, "--model", "private-example"]),
  row("invalid-source", ["analyze", "--source", "private-example"]),
  row("missing-meeting-id", ["analyze", "--source", "file"]),
  row("invalid-granola-transport", [...analyze, "--granola-transport", "private-example"]),
  row("transport-requires-granola", [...analyze, "--granola-transport", "api"]),
  row("conflicting-video-inputs", [...analyze, "--recording-url", "private-example"]),
  row("recording-url-requires-bluedot", ["analyze", "id", "--source", "file", "--recording-url", "private-example"]),
  row("missing-context-file", ["analyze", "id", "--source", "file"]),
  row("context-file-requires-file-source", [...analyze, "--context-file", "private-example"]),
  row("missing-video", ["analyze", "--source", "none"]),
  row("invalid-max-moments", [...analyze, "--max-moments", "0"]),
  row("invalid-concurrency", [...analyze, "--concurrency", "0"]),
  row("remote-file-requires-video", ["analyze", "id", "--source", "file", "--context-file", "doc.txt", "--remote-file", "files/fixture"]),
  row("invalid-remote-file", [...analyze, "--remote-file", "private-example"]),
  row("invalid-file-clock", [...analyze, "--file-clock", "private-example"]),
  row("invalid-transcript-offset", ["analyze", "id", "--source", "file", "--context-file", "doc.txt", "--transcript-offset", "bad"]),
  row("--transcript-offset requires meeting or file context.", [...analyze, "--transcript-offset", "00:01"]),
  row("A range cannot reuse a remote file.", [...analyze, "--from", "1", "--remote-file", "files/fixture"]),
  row("Invalid range bound.", [...analyze, "--from", "bad"]),
  row("Audio bounds use seconds or Nsamp.", ["transcribe", "audio.wav", "--to", "1f"]),
  row("Specify the source drop-frame mode or use frames.", [...analyze, "--from", "00:00:00:01"]),
  row("a bound outside the recording", [...analyze, "--to", "200"]),
  row("from at or after to", [...analyze, "--from", "2", "--to", "1"]),
  row("a range shorter than the tool can analyse", [...analyze, "--to", "1f"]),
  row("Range requires a locally verifiable cut.", ["transcribe", "broken.mp4", "--from", "0"]),
  {reason: "Range requires a locally verifiable cut.", args: ["analyze", "--source", "none", "--video", "varying.mp4", "--from", "0"], timing: true},
];

beforeAll(() => {
  mkdirSync(join(root, "folder.md"));
  writeFileSync(join(root, "large.md"), Buffer.alloc(65537));
  writeFileSync(join(root, "binary.md"), Buffer.from([0]));
  writeFileSync(join(root, "encoding.md"), Buffer.from([0xff]));
  writeFileSync(join(root, "broken.json"), "{");
  writeFileSync(join(root, "broken.mp4"), "invalid");
  copyFileSync("test/fixtures/timeline-export-2997df.otio", join(root, "sequence.otio"));
  const media = (...args: string[]) => execFileSync("ffmpeg", ["-v", "error", "-nostdin", "-f", "lavfi", "-i", ...args],
    {cwd: root, env: childEnvironment("media")});
  media("color=s=16x16:r=30000/1001:d=3", "-c:v", "libx264", "-bf", "0", "clip.mp4");
  media("sine=sample_rate=8000:duration=2", "audio.wav");
  media("color=s=16x16:r=25:d=1", "-vf", "select=not(eq(mod(n\\,3)\\,2))", "-fps_mode", "vfr",
    "-c:v", "libx264", "-bf", "0", "-video_track_timescale", "1000", "varying.mp4");
});
afterAll(() => rmSync(root, {recursive: true, force: true}));

function invoke(args: string[]) {
  const result = spawnSync("bun", ["--no-env-file", entry, ...args], {cwd: root, encoding: "utf8",
    env: {...childEnvironment("media"), HOME: root, TMPDIR: root, GEMINI_API_KEY: "fixture",
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", FRAME_OF_MIND_KEY_COMMAND: "none"}});
  if (result.error) throw result.error;
  return result;
}

it.each(rows)("JSON $reason for $args", ({args, jsonArgs, reason, timing}) => {
  const result = invoke(jsonArgs ?? [...args, "--json"]);
  const error = JSON.parse(result.stdout).error;
  expect(error.details?.reason).toBe(reason);
  expect(error.code).toBe("USAGE");
  expect(result.status).toBe(2);
  expect(result.stdout + result.stderr).not.toContain("private-example");
  if (timing) expect(error.details.frameTiming).toMatchObject({varying: true, frames: expect.any(Number)});
});
it.each(rows)("plain exit for $reason with $args", ({args, plainExit}) => {
  const result = invoke(args);
  expect(result.status, result.stderr).toBe(plainExit ?? 2);
});

it("covers the usage constructors and the parser reason map with command-line rows", () => {
  const words = new Set(rows.map(r => r.reason));
  // The missing-command parser path only occurs in plain mode (empty argv above).
  if (rows.some(r => !r.args.length && r.plainExit === 2)) words.add("missing-command");
  for (const path of readdirSync("src", {recursive: true, encoding: "utf8"}).filter(f => f.endsWith(".ts"))) {
    const source = ts.createSourceFile(path, readFileSync(join("src", path), "utf8"), ts.ScriptTarget.Latest, true);
    function check(node: ts.Node) {
      if (ts.isNewExpression(node) || ts.isCallExpression(node)) {
        const name = node.expression.getText(source);
        const args = node.arguments ?? [];
        if (args.some(arg => ts.isStringLiteral(arg) && arg.text === "USAGE")) {
          expect(name, path + ": bare USAGE constructor").toBe("super");
          expect(args[2]?.getText(source), path).toContain("reason");
        }
        if (["UsageError", "OptionError", "TranscriptLanguageError", "rangeUsage"].includes(name)) {
          const reason = args[0];
          if (reason && ts.isStringLiteral(reason)) expect(words.has(reason.text), path + ": " + reason.text).toBe(true);
        }
      }
      if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.name) && node.name.text.startsWith("commander.")) {
        expect(words.has((node.initializer as ts.StringLiteral).text), node.getText(source)).toBe(true);
      }
      ts.forEachChild(node, check);
    }
    check(source);
  }
});
