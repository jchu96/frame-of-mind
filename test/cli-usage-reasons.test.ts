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

type Row = { site: string; alsoRaisedIn?: string; plainReason?: string; reason: string; args: string[]; plainExit?: number; jsonArgs?: string[]; timing?: boolean };
const row = (site: string, reason: string, args: string[], plainExit = 2): Row => ({site, reason, args, plainExit});
const rows: Row[] = [
  row("domain/engine-plan", "conflicting-options", [...analyze, "--proposer", "gemini", "--candidates", "picks.json"]),
  row("domain/engine-plan", "unsupported-engine", [...analyze, "--grader", "private-example"]),
  row("adapters/candidates-file", "invalid-candidates", [...analyze, "--candidates", "broken.json"]),
  row("domain/candidates", "invalid-candidates", [...analyze, "--candidates", "invalid-picks.json"]),
  row("domain/candidates", "candidate-recording-mismatch", [...analyze, "--candidates", "foreign-picks.json"]),
  row("cli-main", "remove-requires-scratch", ["doctor", "--remove", "private-example"]),
  row("cli-main", "invalid-model", ["calibrate", "--model", "private-example"]),
  row("cli-contract", "unknown-option", ["recipes", "--private-example"]),
  row("cli-contract", "unknown-command", ["private-example"]),
  row("cli-contract", "missing-argument", ["transcribe"]),
  row("cli-contract", "missing-required-option", ["analyze", "private-example.mp4", "--recipe", "decisions"]),
  {site: "cli-contract", reason: "missing-option-value", args: ["doctor", "--remove"], jsonArgs: ["doctor", "--json", "--remove"]},
  row("cli-contract", "invalid-argument", [...analyze, "--thinking-level", "private-example"]),
  row("cli-contract", "excess-arguments", ["recipes", "private-example"]),
  // No command without --json displays help as a failure. With --json the root rejects the option.
  {...row("cli-contract", "unknown-option", []), plainReason: "missing-command"},
  // Machine-only validations. The plain invocation follows its own parser or action.
  row("cli-contract", "invalid-schema-version", ["recipes", "--schema-version=bad"]),
  row("cli-contract", "duplicate-schema-version", ["recipes", "--schema-version=1", "--schema-version=1"]),
  row("cli-contract", "version-arguments", ["--version", "extra"], 0),
  row("cli-contract", "help-with-json", ["--help"], 0),
  row("cli", "mcp-with-json", ["mcp", "--help"], 0),
  row("cli-contract", "force-with-json", ["transcribe", "nonexistent.mp4", "--force"], 1),
  row("cli-contract", "json-output-not-selected", ["doctor", "--remove"]),
  row("commands/job-commands", "duplicate-job-option", [...job, "--out", root]),
  // Job subcommands require --json. The plain parser reports that missing option.
  row("services/job-grant", "invalid-job-limit", jobWith("--max-provider-requests", "zero")),
  row("services/job-grant", "invalid-file-limit", jobWith("--max-file-bytes", "2000000001")),
  row("services/job-grant", "invalid-retention", jobWith("--retention", "private-example")),
  row("services/job-grant", "invalid-allowed-models", jobWith("--allowed-models", "private-example")),
  row("services/job-grant", "missing-job-roots", [...job, ...grant]),
  row("services/job-grant", "conflicting-job-roots", [...job, ...grant, "--roots-file", "roots", "--media-root", root]),
  row("commands/snap", "invalid-edge", ["snap", "clip.mp4", "--at", "0", "--edge", "private-example"]),
  row("commands/snap", "invalid-file-clock", ["snap", "clip.mp4", "--at", "0", "--edge", "end", "--file-clock", "private-example"]),
  row("services/media-helpers", "verify-expectation", ["verify", "clip.mp4"]),
  row("services/media-helpers", "missing-output", ["proxy", "clip.mp4", "--output="]),
  row("services/timeline-map", "invalid-map-direction", ["map", "sequence.otio"]),
  row("domain/clock", "missing-drop-frame-mode", ["map", "sequence.otio", "--at", "00:00:00:01"]),
  row("domain/clock", "missing-timeline-offset", [...analyze, "--timecode-rate", "25:ndf"]),
  row("domain/clock", "missing-timecode-rate", [...analyze, "--timeline-offset", "2f"]),
  row("services/transcribe", "invalid-model", ["transcribe", "clip.mp4", "--model", "private-example"]),
  row("domain/retention", "invalid-retention", ["transcribe", "clip.mp4", "--retention", "private-example"]),
  row("domain/retention", "conflicting-retention", ["transcribe", "clip.mp4", "--delete-upload", "--keep-upload"]),
  row("domain/transcript-language", "invalid-transcript-language", ["transcribe", "clip.mp4", "--transcript-language", "@@@"]),
  row("cli-main", "invalid-index-wait", [...analyze, "--index-wait-seconds", "0"]),
  row("cli-main", "invalid-snap", [...analyze, "--snap", "private-example"]),
  row("domain/snap", "invalid-snap-gap", [...analyze, "--snap-gap-ms", "1"]),
  row("domain/snap", "invalid-snap-window", [...analyze, "--snap-window-ms", "1"]),
  row("domain/transcript-language", "conflicting-transcript-language", [...analyze, "--transcript-language", "en", "--no-derived-transcript"]),
  row("domain/transcript-language", "invalid-transcript-language", [...analyze, "--transcript-language", "@@@"]),
  row("domain/retention", "invalid-retention", [...analyze, "--retention", "private-example"]),
  row("domain/retention", "conflicting-retention", [...analyze, "--retention", "run", "--keep-upload"]),
  row("services/run-notes", "too-many-notes", [...analyze, ...Array.from({length: 9}, () => ["--note", "a=a.md"]).flat()]),
  row("services/run-notes", "invalid-note", [...analyze, "--note", "private-example"]),
  row("services/run-notes", "duplicate-note", [...analyze, "--note", "a=a.md", "--note", "a=b.md"]),
  row("services/run-notes", "invalid-note-format", [...analyze, "--note", "n=f.bin"]),
  row("services/run-notes", "invalid-note-file", [...analyze, "--note", "n=folder.md"]),
  row("services/run-notes", "note-too-large", [...analyze, "--note", "n=large.md"]),
  row("services/run-notes", "invalid-note-encoding", [...analyze, "--note", "n=encoding.md"]),
  row("services/run-notes", "binary-note", [...analyze, "--note", "n=binary.md"]),
  row("cli-main", "invalid-label", [...analyze, "--label", " "]),
  row("cli-main", "invalid-recipe-file", [...analyze, "--recipe-file", "broken.json"]),
  row("cli-main", "invalid-depth", [...analyze, "--depth", "private-example"]),
  row("cli-main", "invalid-model", [...analyze, "--model", "private-example"]),
  row("cli-main", "invalid-source", ["analyze", "--source", "private-example"]),
  row("cli-main", "missing-meeting-id", ["analyze", "--source", "file"]),
  row("cli-main", "invalid-context-transport", [...analyze, "--granola-transport", "private-example"]),
  row("cli-main", "transport-source-mismatch", [...analyze, "--granola-transport", "api"]),
  row("cli-main", "conflicting-video-inputs", [...analyze, "--recording-url", "private-example"]),
  row("cli-main", "recording-url-source-mismatch", ["analyze", "id", "--source", "file", "--recording-url", "private-example"]),
  row("cli-main", "missing-context-file", ["analyze", "id", "--source", "file"]),
  row("cli-main", "context-file-requires-file-source", [...analyze, "--context-file", "private-example"]),
  row("cli-main", "missing-video", ["analyze", "--source", "none"]),
  row("cli-main", "invalid-max-moments", [...analyze, "--max-moments", "0"]),
  row("cli-main", "invalid-concurrency", [...analyze, "--concurrency", "0"]),
  row("cli-main", "remote-file-requires-video", ["analyze", "id", "--source", "file", "--context-file", "doc.txt", "--remote-file", "files/fixture"]),
  row("cli-main", "invalid-remote-file", [...analyze, "--remote-file", "private-example"]),
  row("cli-main", "invalid-file-clock", [...analyze, "--file-clock", "private-example"]),
  row("lib/time", "invalid-transcript-offset", ["analyze", "id", "--source", "file", "--context-file", "doc.txt", "--transcript-offset", "bad"]),
  row("cli-main", "--transcript-offset requires meeting or file context.", [...analyze, "--transcript-offset", "00:01"]),
  {...row("cli-main", "A range cannot reuse a remote file.", [...analyze, "--from", "1", "--remote-file", "files/fixture"]), alsoRaisedIn: "services/analyze"},
  row("services/source-recording", "Invalid range bound.", ["transcribe", "audio.wav", "--to", "1", "--timecode-rate", "25"]),
  row("domain/range-clock", "Invalid range bound.", [...analyze, "--from", "bad"]),
  row("domain/range-clock", "Audio bounds use seconds or Nsamp.", ["transcribe", "audio.wav", "--to", "1f"]),
  row("domain/range-clock", "Specify the source drop-frame mode or use frames.", [...analyze, "--from", "00:00:00:01"]),
  row("domain/range-clock", "a bound outside the recording", [...analyze, "--to", "200"]),
  row("domain/range-clock", "from at or after to", [...analyze, "--from", "2", "--to", "1"]),
  row("domain/range-clock", "a range shorter than the tool can analyse", [...analyze, "--to", "1f"]),
  {...row("services/source-recording", "Range requires a locally verifiable cut.", ["transcribe", "broken.mp4", "--from", "0"]), alsoRaisedIn: "services/audio-range"},
  {site: "services/range-scan", reason: "Range requires a locally verifiable cut.", args: ["analyze", "--source", "none", "--video", "varying.mp4", "--from", "0"], timing: true},
];

beforeAll(() => {
  mkdirSync(join(root, "folder.md"));
  writeFileSync(join(root, "large.md"), Buffer.alloc(65537));
  writeFileSync(join(root, "binary.md"), Buffer.from([0]));
  writeFileSync(join(root, "encoding.md"), Buffer.from([0xff]));
  writeFileSync(join(root, "broken.json"), "{");
  writeFileSync(join(root, "invalid-picks.json"), "{}");
  writeFileSync(join(root, "foreign-picks.json"), JSON.stringify({schemaVersion: 1, candidates: [],
    recording: {unit: "video-frame", rate: {num: 30000, den: 1001}, length: "90", recordingSha256: "a".repeat(64)}}));
  writeFileSync(join(root, "broken.mp4"), "invalid");
  writeFileSync(join(root, "offline.ts"), 'globalThis.fetch = () => { throw new Error("Unexpected network request in CLI usage test"); };');
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
  const result = spawnSync("bun", ["--no-env-file", "--preload", join(root, "offline.ts"), entry, ...args], {cwd: root, encoding: "utf8",
    env: {...childEnvironment("media"), HOME: root, TMPDIR: root, GEMINI_API_KEY: "fixture",
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", FRAME_OF_MIND_KEY_COMMAND: "[]"}});
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

// 2026-11-28: bare USAGE hid the caller's mistake. Existing fault tests covered the code alone.
// Review by: 2027-02-28 (protects: user)
it("covers the usage constructors and the parser reason map with command-line rows", () => {
  const sites = new Set<string>();
  for (const {site, reason, plainReason, alsoRaisedIn} of rows) {
    sites.add(site + ":" + reason);
    if (plainReason) sites.add(site + ":" + plainReason);
    if (alsoRaisedIn) sites.add(alsoRaisedIn + ":" + reason);
  }
  for (const path of readdirSync("src", {recursive: true, encoding: "utf8"}).filter(f => f.endsWith(".ts"))) {
    const source = ts.createSourceFile(path, readFileSync(join("src", path), "utf8"), ts.ScriptTarget.Latest, true);
    const site = path.replaceAll("\\", "/").slice(0, -3);
    const requireRow = (reason: string) => {
      const key = site + ":" + reason;
      expect(sites.has(key), path + ": missing CLI row for " + reason).toBe(true);
    };
    function check(node: ts.Node) {
      if (ts.isStringLiteral(node) && node.text === "USAGE") {
        const parent = node.parent;
        const comparison = ts.isBinaryExpression(parent) && [ts.SyntaxKind.EqualsEqualsEqualsToken,
          ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(parent.operatorToken.kind);
        const consumer = ts.isArrayLiteralExpression(parent) && ts.isPropertyAccessExpression(parent.parent)
          && parent.parent.name.text === "includes";
        const constructor = site === "domain/contract-error" && ts.isCallExpression(parent)
          && parent.expression.kind === ts.SyntaxKind.SuperKeyword
          && parent.arguments[0] === node && parent.arguments[2]?.getText(source).includes("reason");
        expect(comparison || consumer || constructor, path + ": bare USAGE").toBeTruthy();
      }
      if (ts.isNewExpression(node) || ts.isCallExpression(node)) {
        const name = node.expression.getText(source);
        const args = node.arguments ?? [];
        if (["UsageError", "OptionError", "TranscriptLanguageError", "rangeUsage", "usage", "parseChoice"].includes(name)) {
          const reason = args[name === "parseChoice" ? 2 : 0];
          if (reason && ts.isStringLiteral(reason)) requireRow(reason.text);
          else if (reason && ts.isConditionalExpression(reason) && ts.isStringLiteral(reason.whenTrue) && ts.isStringLiteral(reason.whenFalse)) {
            requireRow(reason.whenTrue.text);
            requireRow(reason.whenFalse.text);
          } else {
            // Only these adapters forward an already classified reason. All producers need a literal and a row.
            const owner = ts.findAncestor(node, (n): n is ts.FunctionDeclaration | ts.MethodDeclaration =>
              ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n));
            const forwarded = [site, owner?.name?.getText(source), reason?.getText(source)].join(":");
            expect(["domain/contract-error:asUsageError:this.reason", "domain/range-clock:rangeUsage:reason",
              "cli-main:parseChoice:reason", "services/job-grant:usage:reason",
              'cli-contract:parserUsage:parserReasons[error.code] ?? "invalid-argument"']).toContain(forwarded);
          }
        }
      }
      if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.name) && node.name.text.startsWith("commander.")) {
        requireRow((node.initializer as ts.StringLiteral).text);
      }
      ts.forEachChild(node, check);
    }
    check(source);
  }
});
