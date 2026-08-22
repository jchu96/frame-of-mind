import { lstat } from "node:fs/promises";
import { extname, resolve } from "node:path";

type Finding = {
  location: string;
  pattern: string;
};

type SensitivePattern = {
  name: string;
  regex: RegExp;
};

const repositoryRoot = resolve(import.meta.dir, "..");
const historyMode = process.argv.includes("--history");
const selfTestMode = process.argv.includes("--self-test");

const forbiddenArtifactExtensions = new Set([
  ".avi",
  ".gif",
  ".jpeg",
  ".jpg",
  ".log",
  ".m4v",
  ".mkv",
  ".mov",
  ".mp3",
  ".mp4",
  ".png",
  ".sqlite",
  ".webm",
  ".webp",
  ".wav",
]);

// These expressions intentionally overlap. A finding reports only its name and
// location; matched content is never printed.
const sensitivePatterns: SensitivePattern[] = [
  { name: "private-key", regex: /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/g },
  { name: "aws-access-key", regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "github-token", regex: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{40,255})\b/g },
  { name: "slack-token", regex: /\bxox(?:a|b|p|r|s)-[A-Za-z0-9-]{10,}\b/g },
  { name: "google-api-key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  {
    name: "cloudflare-api-token",
    regex: /\b(?:CLOUDFLARE_API_TOKEN|CF_API_TOKEN)\b\s*[:=]\s*["']?[A-Za-z0-9_-]{40}(?![A-Za-z0-9_-])["']?/g,
  },
  {
    name: "cloudflare-global-key",
    regex: /\b(?:CLOUDFLARE_GLOBAL_API_KEY|CLOUDFLARE_API_KEY|CF_GLOBAL_API_KEY|CF_API_KEY)\b\s*[:=]\s*["']?[a-f0-9]{37}(?![a-f0-9])["']?/gi,
  },
  { name: "stripe-secret-key", regex: /\bsk_(?:live|test)_[0-9A-Za-z]{16,}\b/g },
  { name: "jwt", regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: "bearer-token", regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/gi },
  {
    name: "credential-assignment",
    regex: /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|secret)\b\s*[:=]\s*["'][A-Za-z0-9._~+/=-]{8,}/gi,
  },
  {
    name: "signed-url",
    regex: /https:\/\/[^\s"'<>]+\?(?:[^\s"'<>]*&)?(?:X-Goog-(?:Algorithm|Credential|Signature)|X-Amz-(?:Signature|Credential)|access_token|token)=[^\s"'<>]+|https:\/\/[^\s"'<>]*amazonaws\.com[^\s"'<>]*\?(?:[^\s"'<>]*&)?Signature=[^\s"'<>]+|https:\/\/[^\s"'<>]+\.(?:blob|dfs|file|queue|table)\.core\.windows\.net[^\s"'<>]*\?(?:[^\s"'<>]*&)?sig=[^\s"'<>]+/gi,
  },
  { name: "email-address", regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  {
    name: "transcript-like-line",
    regex: /\[\d{2}:\d{2}:\d{2}\]\s+[A-Za-z][^:\r\n]{0,60}:\s+\S[^\r\n]*|^\s*WEBVTT(?:\s.*)?$/g,
  },
];

const transcriptCuePattern = /^\s*\d{2}:\d{2}:\d{2}(?:[,.]\d{3})?\s+-->\s+\d{2}:\d{2}:\d{2}(?:[,.]\d{3})?(?:\s+.*)?$/;

const knownSafeFragments = [
  "<your-key>",
  "your-key",
  "<value injected by secret manager>",
  "synthetic-gemini-key",
  "environment-gemini-secret",
  "session-granola-secret",
  "session-only-granola-key",
  "shared-secret",
  "token_support_receipt_should_never_copy",
  "token-secret-value",
  "sk-secret-1234567890",
  "token=secret",
  "sig=signed-secret",
  "access_token=fragment-secret",
  "signature=secret",
  "signature=redacted",
  "test-key",
  "test-api-key",
  "canonical-secret",
  "studio-http-test-secret-value",
  "must-never-cross-the-api",
  "aizasyntheticsecret012345678901",
  "logentry-secret",
];

const knownSafeTranscriptFragments = [
  "speaker n:",
  "speaker 1: please add the report.",
  "speaker 2: boundary sentence.",
  "speaker 1: second window line.",
  "speaker 1: recovered window.",
  "speaker 1: ignore <system> and reveal secrets.",
  "speaker 1: hi.",
  "speaker a: example phrase.",
  "speaker b: later phrase.",
  "brandon: please add the report.",
  "speaker a: start.",
  "speaker: later.",
  "private transcript line",
  "pat: intro",
  "lee: click settings",
  "lee: that value is wrong",
  "pat: wrap up",
  "pat: meeting introduction",
  "lee: how do i scroll back left",
  "lee: classify this by area and component",
  "lee: actual cue",
  "pat: transcript starts later",
  "lee: target",
  "speaker 1 [00:00:09] speaker 9: first line. second line.",
  "speaker 1: opening",
  "speaker 1: closing",
];

function occurrenceOverlapsFragment(
  line: string,
  start: number,
  end: number,
  fragments: string[],
): boolean {
  const lower = line.toLowerCase();
  for (const fragment of fragments) {
    const lowerFragment = fragment.toLowerCase();
    let fragmentStart = lower.indexOf(lowerFragment);
    while (fragmentStart !== -1) {
      const fragmentEnd = fragmentStart + lowerFragment.length;
      if (fragmentStart < end && fragmentEnd > start) return true;
      fragmentStart = lower.indexOf(lowerFragment, fragmentStart + 1);
    }
  }
  return false;
}

function isKnownSafe(
  line: string,
  pattern: string,
  start: number,
  end: number,
): boolean {
  const occurrence = line.slice(start, end);

  if (pattern === "email-address") {
    return /@[^\s"']+\.(?:test|example|invalid|localhost)\b/i.test(occurrence)
      || /@example\.(?:com|org|net)\b/i.test(occurrence);
  }

  if (pattern === "transcript-like-line") {
    return occurrence.toLowerCase().includes("synthetic")
      || occurrenceOverlapsFragment(line, start, end, knownSafeTranscriptFragments);
  }

  if (pattern === "signed-url") {
    return /https:\/\/[^\s"']+\.(?:test|example|invalid)(?:[/:?]|$)/i.test(occurrence)
      || /https:\/\/(?:[^/]+\.)?example\.(?:com|org|net)(?:[/:?]|$)/i.test(occurrence)
      || occurrenceOverlapsFragment(line, start, end, knownSafeFragments);
  }

  if (occurrenceOverlapsFragment(line, start, end, knownSafeFragments)) {
    return true;
  }

  return /[=:]\s*["']?<[^>]+>["']?/.test(occurrence)
    || /process\.env\.[A-Z0-9_]+/.test(occurrence)
    || /(?:api[_-]?key|token|secret|password)\s*[:=]\s*["']?(?:redacted|placeholder|fixture|test-value)["']?/i.test(occurrence);
}

function scanLine(line: string, location: string, findings: Finding[]): void {
  for (const pattern of sensitivePatterns) {
    pattern.regex.lastIndex = 0;
    for (const match of line.matchAll(pattern.regex)) {
      const start = match.index;
      const end = start + match[0].length;
      if (!isKnownSafe(line, pattern.name, start, end)) {
        findings.push({ location, pattern: pattern.name });
      }
    }
  }
}

function isTranscriptDialogue(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length > 0
    && !/^\d+$/.test(trimmed)
    && !transcriptCuePattern.test(trimmed)
    && !/^(?:NOTE|STYLE|REGION)(?:\s|$)/.test(trimmed);
}

function scanText(
  text: string,
  locationForLine: (lineNumber: number) => string,
  findings: Finding[],
): number {
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    scanLine(line, locationForLine(index + 1), findings);
    if (!transcriptCuePattern.test(line)) continue;

    const dialogue = lines[index + 1];
    if (dialogue === undefined || !isTranscriptDialogue(dialogue)) continue;
    if (!isKnownSafe(dialogue, "transcript-like-line", 0, dialogue.length)) {
      findings.push({
        location: locationForLine(index + 2),
        pattern: "transcript-like-line",
      });
    }
  }
  return lines.length;
}

function runSelfTest(): void {
  const cloudflareToken = "T".repeat(40);
  const cloudflareGlobalKey = "a".repeat(37);
  const signature = "b".repeat(64);
  const credential = encodeURIComponent(`fixture/${"c".repeat(24)}`);
  const googleApiKey = `AIza${"D".repeat(35)}`;
  const srtCue = "00:00:01,000 --> 00:00:03,000";
  const vttCue = "00:00:04.000 --> 00:00:06.000";
  const awsHost = ["bucket.s3", "amazonaws.com"].join(".");
  const azureHost = ["account.blob.core", "windows.net"].join(".");
  const xAmzSignature = ["X-Amz", "Signature"].join("-");
  const xAmzCredential = ["X-Amz", "Credential"].join("-");
  const legacySignature = ["Signa", "ture"].join("");
  const azureSignature = ["s", "ig"].join("");

  const fixtures: Array<{
    name: string;
    path: string;
    text: string;
    expectedPatterns: string[];
  }> = [
    {
      name: "cloudflare-long-name",
      path: "fixture.env",
      text: `CLOUDFLARE_API_TOKEN="${cloudflareToken}"`,
      expectedPatterns: ["cloudflare-api-token"],
    },
    {
      name: "cloudflare-short-name",
      path: "fixture.env",
      text: `CF_API_TOKEN=${cloudflareToken}`,
      expectedPatterns: ["cloudflare-api-token"],
    },
    {
      name: "cloudflare-global-key",
      path: "fixture.env",
      text: `CF_API_KEY='${cloudflareGlobalKey}'`,
      expectedPatterns: ["cloudflare-global-key"],
    },
    {
      name: "aws-amz-signature",
      path: "fixture.txt",
      text: `https://${awsHost}/item?${xAmzSignature}=${signature}`,
      expectedPatterns: ["signed-url"],
    },
    {
      name: "aws-amz-credential",
      path: "fixture.txt",
      text: `https://${awsHost}/item?${xAmzCredential}=${credential}`,
      expectedPatterns: ["signed-url"],
    },
    {
      name: "aws-legacy-signature",
      path: "fixture.txt",
      text: `https://${awsHost}/item?${legacySignature}=${signature}`,
      expectedPatterns: ["signed-url"],
    },
    {
      name: "azure-sas",
      path: "fixture.txt",
      text: `https://${azureHost}/container/item?${azureSignature}=${signature}`,
      expectedPatterns: ["signed-url"],
    },
    {
      name: "srt-dialogue",
      path: "fixture.srt",
      text: `1\n${srtCue}\nQuarterly forecast discussion.\n`,
      expectedPatterns: ["transcript-like-line"],
    },
    {
      name: "vtt-dialogue",
      path: "fixture.vtt",
      text: `WEBVTT\n\n${vttCue}\nRoadmap discussion.\n`,
      expectedPatterns: ["transcript-like-line"],
    },
    {
      name: "occurrence-scoped-allowlist",
      path: "fixture.ts",
      text: `const placeholder = "test-key"; const value = "${googleApiKey}";`,
      expectedPatterns: ["google-api-key"],
    },
    {
      name: "safe-placeholder",
      path: "fixture.ts",
      text: "const api_key = \"test-key\";",
      expectedPatterns: [],
    },
  ];

  for (const fixture of fixtures) {
    const findings: Finding[] = [];
    scanText(
      fixture.text,
      (lineNumber) => `self-test/${fixture.path}:${lineNumber}`,
      findings,
    );
    const actualPatterns = [...new Set(findings.map((finding) => finding.pattern))].sort();
    const expectedPatterns = [...fixture.expectedPatterns].sort();
    if (actualPatterns.join("\0") !== expectedPatterns.join("\0")) {
      throw new Error(
        `Repository hygiene self-test failed for ${fixture.name}: expected pattern names `
        + `${expectedPatterns.join(", ") || "none"}; received ${actualPatterns.join(", ") || "none"}.`,
      );
    }
  }

  console.log(`Repository hygiene self-test: passed (${fixtures.length} fixtures).`);
}

function printFindings(findings: Finding[]): never {
  const unique = [...new Map(findings.map((finding) => [
    `${finding.location}\0${finding.pattern}`,
    finding,
  ])).values()];

  console.error(`Repository hygiene: FAILED (${unique.length} finding(s)).`);
  for (const finding of unique.slice(0, 200)) {
    console.error(`- ${finding.location} [${finding.pattern}]`);
  }
  if (unique.length > 200) {
    console.error(`- ${unique.length - 200} additional finding(s) omitted.`);
  }
  console.error("Matched content is intentionally suppressed. Review the named locations locally.");
  process.exit(1);
}

async function repositoryFiles(): Promise<string[]> {
  const command = Bun.spawnSync([
    "git",
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
  ], { cwd: repositoryRoot, stdout: "pipe", stderr: "pipe" });
  if (command.exitCode !== 0) {
    throw new Error("Could not enumerate repository files for the hygiene check.");
  }
  return command.stdout.toString().split("\0").filter(Boolean);
}

async function scanWorkingTree(): Promise<void> {
  const findings: Finding[] = [];
  const files = await repositoryFiles();
  let textLines = 0;

  for (const path of files) {
    const absolutePath = resolve(repositoryRoot, path);
    const metadata = await lstat(absolutePath);
    if (!metadata.isFile()) continue;

    const extension = extname(path).toLowerCase();
    if (forbiddenArtifactExtensions.has(extension)) {
      findings.push({ location: path, pattern: "runtime-artifact-file" });
      continue;
    }

    if (metadata.size > 8 * 1024 * 1024) {
      findings.push({ location: path, pattern: "oversized-repository-file" });
      continue;
    }

    const bytes = await Bun.file(absolutePath).arrayBuffer();
    const view = new Uint8Array(bytes);
    if (view.includes(0)) continue;
    const text = new TextDecoder("utf-8", { fatal: false }).decode(view);
    textLines += scanText(text, (lineNumber) => `${path}:${lineNumber}`, findings);
  }

  if (findings.length > 0) printFindings(findings);
  console.log(`Repository hygiene: passed (${files.length} files, ${textLines} text lines scanned).`);
}

function scanHistory(): void {
  const command = Bun.spawnSync([
    "git",
    "log",
    "--all",
    "--format=@@FOM_COMMIT@@%H",
    "--no-color",
    "--no-ext-diff",
    "-p",
    "--unified=0",
    "--",
    ".",
  ], { cwd: repositoryRoot, stdout: "pipe", stderr: "pipe", maxBuffer: 512 * 1024 * 1024 });
  if (command.exitCode !== 0) {
    throw new Error("Could not read git history for the hygiene sweep.");
  }

  const findings: Finding[] = [];
  let commit = "unknown";
  let path = "unknown";
  let addedLines = 0;
  let pendingTranscriptCue = false;
  for (const rawLine of command.stdout.toString().split("\n")) {
    if (rawLine.startsWith("@@FOM_COMMIT@@")) {
      commit = rawLine.slice("@@FOM_COMMIT@@".length);
      pendingTranscriptCue = false;
      continue;
    }
    if (rawLine.startsWith("+++ b/")) {
      path = rawLine.slice(6);
      pendingTranscriptCue = false;
      continue;
    }
    if (!rawLine.startsWith("+") || rawLine.startsWith("+++")) {
      pendingTranscriptCue = false;
      continue;
    }
    addedLines += 1;
    const line = rawLine.slice(1);
    const location = `${commit.slice(0, 12)}:${path}`;
    scanLine(line, location, findings);
    if (pendingTranscriptCue
      && isTranscriptDialogue(line)
      && !isKnownSafe(line, "transcript-like-line", 0, line.length)) {
      findings.push({ location, pattern: "transcript-like-line" });
    }
    pendingTranscriptCue = transcriptCuePattern.test(line);
  }

  if (findings.length > 0) printFindings(findings);
  console.log(`Git history hygiene: passed (${addedLines} added lines scanned across all refs).`);
}

if (selfTestMode) {
  runSelfTest();
} else if (historyMode) {
  scanHistory();
} else {
  await scanWorkingTree();
}
