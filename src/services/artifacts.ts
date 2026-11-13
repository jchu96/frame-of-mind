import { clockTime, fileToTimeline, renderTimecode, type RunClock } from "../domain/clock.js";
import { timestampToSeconds } from "../lib/time.js";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type {
  VersionedAnalysisRun,
  VersionedRunManifest,
} from "../domain/types.js";
import { ensureDirectory } from "../lib/files.js";
import { canonicalAnalysisJson } from "../domain/integrity.js";
import {
  analysisOutcomeSchema,
  type AnalysisOutcome,
} from "../domain/analysis-outcome.js";
import {
  runFailureManifestSchema,
  type RunFailureManifest,
} from "../domain/run-failure.js";

export async function writeFailureManifest(
  directory: string,
  manifest: RunFailureManifest,
): Promise<string> {
  const validated = runFailureManifestSchema.parse(manifest);
  await ensureDirectory(directory);
  const path = join(directory, "failure-manifest.json");
  await writeFile(path, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
  return path;
}

export async function writeArtifacts(
  directory: string,
  analysis: VersionedAnalysisRun,
  manifest: VersionedRunManifest,
  outcome: AnalysisOutcome,
): Promise<string[]> {
  if (analysis.schemaVersion !== manifest.schemaVersion) {
    throw new Error("Analysis and manifest schema versions must match.");
  }
  const validatedOutcome = analysisOutcomeSchema.parse(outcome);
  if (analysis.runId !== validatedOutcome.runId) {
    throw new Error("Analysis and outcome run IDs must match.");
  }
  const acceptedItems = analysis.items.filter((item) => item.result.accepted).length;
  const rejectedItems = analysis.items.length - acceptedItems;
  if (
    validatedOutcome.candidates.validated !== analysis.items.length
    || validatedOutcome.candidates.accepted !== acceptedItems
    || validatedOutcome.candidates.rejected !== rejectedItems
  ) {
    throw new Error("Analysis items and outcome candidate counts must match.");
  }
  await ensureDirectory(directory);
  const analysisJson = join(directory, "analysis.json");
  const outcomeJson = join(directory, "analysis-outcome.json");
  const analysisMarkdown = join(directory, "analysis.md");
  const reportHtml = join(directory, "report.html");
  const manifestJson = join(directory, "manifest.json");
  await writeFile(analysisJson, canonicalAnalysisJson(analysis), { mode: 0o600 });
  await writeFile(
    outcomeJson,
    `${JSON.stringify(validatedOutcome, null, 2)}\n`,
    { mode: 0o600 },
  );
  await writeFile(analysisMarkdown, renderAnalysis(analysis, validatedOutcome, manifest.clock), { mode: 0o600 });
  await writeFile(
    reportHtml,
    await renderHtmlArtifact(directory, analysis, manifest, validatedOutcome),
    { mode: 0o600 },
  );
  await writeFile(manifestJson, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  const timesJson = join(directory, "times.json");
  await writeFile(timesJson, `${JSON.stringify(buildTimes(analysis, manifest.clock), null, 2)}\n`, { mode: 0o600 });
  return [analysisJson, outcomeJson, analysisMarkdown, reportHtml, manifestJson, timesJson];
}

export function renderAnalysis(
  analysis: VersionedAnalysisRun,
  outcome?: AnalysisOutcome,
  clock?: RunClock,
): string {
  const accepted = analysis.items.filter((item) => item.result.accepted);
  const heading = analysis.schemaVersion === 2
    ? analysis.meeting.title || `Meeting ${analysis.meeting.id}`
    : "Video analysis";
  const contextLine = analysis.schemaVersion === 2
    ? `- Meeting: \`${escapeInline(analysis.meeting.id)}\``
    : "- Context: Video only (no external context)";
  const lines = [
    `# ${escapeInline(heading)}`,
    "",
    contextLine,
    `- Recipe: \`${escapeInline(analysis.recipe.id)}\``,
    `- Model: \`${escapeInline(analysis.model)}\``,
    `- ${clockSummary(clock)}`,
    `- Accepted records: ${accepted.length}`,
    ...(outcome
      ? [
          `- Analysis outcome: ${outcome.status}`,
          `- Candidate responses: ${outcome.candidates.validated}/${outcome.candidates.selected} validated (${outcome.candidates.accepted} accepted, ${outcome.candidates.rejected} rejected)`,
          `- Indexed candidates: ${outcome.candidates.indexed} (${outcome.candidates.outOfRange ?? 0} out of range; ${outcome.candidates.omittedByLimit} omitted by the configured limit)`,
        ]
      : []),
    "",
    outcome && outcome.candidates.failed > 0
      ? `> ${outcome.candidates.failed} candidate response(s) failed validation and were excluded. See \`analysis-outcome.json\` for sanitized diagnostics.`
      : "",
    outcome && outcome.candidates.omittedByLimit > 0
      ? `> Coverage truncated: ${outcome.candidates.omittedByLimit} indexed candidate(s) were never interrogated because of the configured moment limit. Lower-importance candidates are missing from this analysis; rerun with a higher \`--max-moments\` for full coverage.`
      : "",
    outcome && (outcome.candidates.failed > 0 || outcome.candidates.omittedByLimit > 0) ? "" : "",
    analysis.matchNotes ? "## Recording match notes" : "",
    analysis.matchNotes ? renderBlock(analysis.matchNotes) : "",
    "",
  ];
  for (const [index, item] of accepted.entries()) {
    const result = item.result;
    lines.push(
      `## ${index + 1}. ${escapeInline(result.title)}`,
      "",
      `- Kind: ${escapeInline(result.kind)}`,
      `- Time: ${escapeInline(renderClockTime(result.evidence?.timestamp || item.candidate.start, clock))}`,
      `- Importance: ${escapeInline(result.importance || item.candidate.importance)}`,
      `- Surface: ${escapeInline(result.where?.surface || item.candidate.surface || "Unknown")}`,
      result.where?.appUrl ? `- URL: ${escapeInline(result.where.appUrl)}` : "- URL: Not visibly confirmed",
      "",
      "### Summary",
      "",
      renderBlock(result.summary),
      "",
    );
    if (result.details?.length) {
      lines.push(
        "### Details",
        "",
        ...result.details.map((detail) => `- **${escapeInline(detail.label)}:** ${escapeInline(detail.value)}`),
        "",
      );
    }
    if (result.evidence?.verbatimUiText) {
      lines.push("### Verbatim UI evidence", "", renderBlock(result.evidence.verbatimUiText), "");
    }
    if (result.evidence?.reporterQuote) {
      lines.push(
        analysis.schemaVersion === 2 ? "### Meeting quote" : "### Recording quote",
        "",
        renderBlock(result.evidence.reporterQuote),
        "",
      );
    }
    if (result.steps?.length) {
      lines.push(
        "### Observed sequence",
        "",
        ...result.steps.map((step, stepIndex) => `${stepIndex + 1}. ${escapeInline(step)}`),
        "",
      );
    }
    if (item.screenshot && /^moment-\d+\.png$/.test(basename(item.screenshot))) {
      lines.push(`![Screen evidence](./${basename(item.screenshot)})`, "");
    }
    if (result.confidenceNotes) lines.push(`_Confidence: ${escapeInline(result.confidenceNotes)}_`, "");
  }
  if (!accepted.length) lines.push("No candidate survived the recipe interrogation pass.", "");
  return `${lines.filter((line, index) => line || lines[index - 1]).join("\n").trim()}\n`;
}

async function renderHtmlArtifact(
  directory: string,
  analysis: VersionedAnalysisRun,
  manifest: VersionedRunManifest,
  outcome: AnalysisOutcome,
): Promise<string> {
  const accepted = analysis.items.filter((item) => item.result.accepted);
  const cards = await Promise.all(accepted.map(async (item, index) => {
    const result = item.result;
    let image = "";
    if (item.screenshot && /^moment-\d+\.png$/.test(basename(item.screenshot))) {
      const bytes = await readFile(join(directory, basename(item.screenshot)));
      image = `<img src="data:image/png;base64,${bytes.toString("base64")}" alt="Screen evidence for record ${index + 1}">`;
    }
    const steps = result.steps?.length
      ? `<ol>${result.steps.map((step) => `<li>${html(step)}</li>`).join("")}</ol>`
      : "<p class=\"muted\">No observed sequence was recorded.</p>";
    const details = result.details?.length
      ? `<dl>${result.details.map((detail) =>
          `<dt>${html(detail.label)}</dt><dd>${html(detail.value)}</dd>`).join("")}</dl>`
      : "";
    return `<article>
      <div class="eyebrow">${html(result.kind)} · ${html(result.importance || item.candidate.importance)} · ${html(renderClockTime(result.evidence?.timestamp || item.candidate.start, manifest.clock))}</div>
      <h2>${index + 1}. ${html(result.title)}</h2>
      <p>${html(result.summary)}</p>
      ${details}
      <dl>
        <dt>Surface</dt><dd>${html(result.where?.surface || item.candidate.surface || "Unknown")}</dd>
      </dl>
      ${result.evidence?.reporterQuote ? `<blockquote>${html(result.evidence.reporterQuote)}</blockquote>` : ""}
      <h3>Observed sequence</h3>${steps}
      ${image}
      ${result.confidenceNotes ? `<p class="muted">Confidence: ${html(result.confidenceNotes)}</p>` : ""}
    </article>`;
  }));
  const heading = analysis.schemaVersion === 2
    ? analysis.meeting.title || `Meeting ${analysis.meeting.id}`
    : "Video analysis";
  const providerLabel = analysis.schemaVersion === 2
    ? analysis.meeting.provider
    : "video only";
  const safeSourceUrl = analysis.schemaVersion === 2
    ? safeHref(analysis.meeting.sourceUrl)
    : undefined;
  const source = safeSourceUrl
    ? `<a href="${htmlAttribute(safeSourceUrl)}" rel="noreferrer">Open source meeting</a>`
    : analysis.schemaVersion === 2
      ? "No provider URL retained"
      : "No external context supplied";
  const alignment = `${clockSummary(manifest.clock)}. ` + (manifest.derivedTranscript
    ? "Transcript: derived from this recording's own audio by the analysis model (offset 0); no provider or operator transcript was supplied."
    : manifest.schemaVersion === 2
      ? `Transcript alignment: ${manifest.transcriptAlignment.offsetSeconds >= 0 ? "+" : ""}${manifest.transcriptAlignment.offsetSeconds}s (${html(manifest.transcriptAlignment.method)}, ${html(manifest.transcriptAlignment.confidence)} confidence).`
      : "Transcript alignment: not applicable to a video-only run.");
  const outcomeReasons = [
    outcome.candidates.failed > 0
      ? `${outcome.candidates.failed} candidate response(s) failed validation and were excluded; sanitized diagnostics are available in <code>analysis-outcome.json</code>.`
      : "",
    outcome.candidates.omittedByLimit > 0
      ? `${outcome.candidates.omittedByLimit} indexed candidate(s) were never interrogated because of the configured moment limit, so lower-importance candidates are missing; rerun with a higher <code>--max-moments</code> for full coverage.`
      : "",
  ].filter(Boolean).join(" ");
  const outcomeNotice = outcome.status === "complete"
    ? ""
    : `<aside><strong>${html(outcome.status === "partial" ? "Partial analysis" : "Analysis failed")}</strong>: ${outcomeReasons}</aside>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${html(heading)} — Frame of Mind</title>
  <style>
    :root{color-scheme:light dark;--bg:#f5f3ee;--card:#fff;--ink:#1d2524;--muted:#67716e;--line:#d9ddd9;--accent:#0e766e}
    @media(prefers-color-scheme:dark){:root{--bg:#111615;--card:#19201f;--ink:#edf3f1;--muted:#9aaba7;--line:#34403d;--accent:#68d4c6}}
    *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 ui-sans-serif,system-ui,-apple-system,sans-serif}
    main{max-width:1040px;margin:auto;padding:48px 24px 80px}header{border-bottom:1px solid var(--line);padding-bottom:28px;margin-bottom:28px}
    h1{font-size:clamp(2rem,5vw,4rem);line-height:1.02;margin:.2em 0}.eyebrow{color:var(--accent);font-size:.78rem;font-weight:750;letter-spacing:.08em;text-transform:uppercase}
    .meta{display:flex;gap:16px;flex-wrap:wrap;color:var(--muted)}article{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px;margin:22px 0;box-shadow:0 8px 28px rgb(0 0 0/.05)}
    h2{line-height:1.2;margin:.35em 0 1em}h3{font-size:1rem;margin-top:24px}dl{display:grid;grid-template-columns:110px 1fr;gap:10px 18px}dt{color:var(--muted);font-weight:700}dd{margin:0}
    blockquote{border-left:4px solid var(--accent);margin:24px 0;padding:4px 18px;font-size:1.12rem}img{display:block;max-width:100%;height:auto;border:1px solid var(--line);border-radius:9px;margin-top:24px}
    a{color:var(--accent)}.muted{color:var(--muted)}code{overflow-wrap:anywhere}@media(max-width:600px){main{padding:28px 14px}article{padding:20px}dl{grid-template-columns:1fr;gap:2px}dd{margin-bottom:10px}}
    aside{border:1px solid var(--line);border-left:4px solid var(--accent);border-radius:8px;padding:14px 16px;margin:20px 0;background:var(--card)}
  </style>
</head>
<body><main>
  <header>
    <div class="eyebrow">Frame of Mind · ${html(providerLabel)} · ${html(analysis.recipe.label)}</div>
    <h1>${html(heading)}</h1>
    <div class="meta"><span>${accepted.length} accepted record(s)</span><span>Model ${html(analysis.model)}</span><span>${source}</span></div>
  </header>
  ${outcomeNotice}
  <section><h2>Recording match</h2><p>${html(analysis.matchNotes || "No match notes returned.")}</p>
    <p class="muted">${alignment}</p>
  </section>
  ${cards.join("\n") || "<article><h2>No accepted records</h2><p>No candidate survived the recipe interrogation pass.</p></article>"}
  <footer class="muted"><p>Portable review rendering. The versioned source of truth is <code>analysis.json</code>; run provenance is in <code>manifest.json</code>.</p></footer>
</main></body></html>
`;
}

function cleanText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
}

function escapeInline(value: string): string {
  return cleanText(value)
    .replace(/\r?\n/g, " ")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([\\`*_[\]{}()#+\-.!|>])/g, "\\$1");
}

function renderBlock(value: string): string {
  return cleanText(value)
    .split(/\r?\n/)
    .map((line) => `    ${line}`)
    .join("\n");
}

function html(value: string): string {
  return cleanText(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] || character);
}

function htmlAttribute(value: string): string {
  return html(value).replace(/[\r\n]/g, "");
}

function safeHref(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function clockSummary(clock?: RunClock): string {
  return `clocks: ${clock?.fileClock ?? "source"}${clock?.timeline ? `, timeline +${(clock.timeline.timelineOffsetMs / 1000).toFixed(3)} s` : ""}; model clip clock: ${clock?.modelClipClock ?? "unverified"}${!clock || clock.modelClipClock === "unverified" ? " (clip clock unverified)" : ""}${clock?.clipGuard === "unknown-duration" ? "; clip guard did not run: duration unknown" : ""}${clock?.transcriptWindow === "not-windowed" ? "; transcript not windowed" : ""}`;
}

export function renderClockTime(timestamp: string, clock?: RunClock): string {
  const time = clockTime(clock?.fileClock ?? "source", timestampToSeconds(timestamp) * 1000);
  let text = `${(time.ms / 1000).toFixed(3)} s ${time.clock}`;
  if (clock?.timeline) {
    const timeline = fileToTimeline(time, clock.timeline.timelineOffsetMs);
    text += ` · ${(timeline.ms / 1000).toFixed(3)} s timeline`;
    if (clock.timeline.timecode) {
      const { rate, dropFrame } = clock.timeline.timecode;
      text += ` · ${renderTimecode(timeline.ms, rate, dropFrame)} @${rate.den === 1 ? rate.num : `${rate.num}/${rate.den}`}`;
    }
  }
  return `${text} (≈1 s)`;
}

export function buildTimes(analysis: VersionedAnalysisRun, clock?: RunClock) {
  const fileClock = clock?.fileClock ?? "source";
  const entries: Array<{ pointer: string; source?: number; reel?: number; precisionMs: number; timeline?: number; timecode?: string }> = [];
  const add = (pointer: string, timestamp: string) => {
    const time = clockTime(fileClock, timestampToSeconds(timestamp) * 1000);
    const entry: typeof entries[number] = { pointer, [fileClock]: time.ms / 1000, precisionMs: time.precisionMs };
    if (clock?.timeline) {
      const timeline = fileToTimeline(time, clock.timeline.timelineOffsetMs);
      entry.timeline = timeline.ms / 1000;
      if (clock.timeline.timecode) {
        const { rate, dropFrame } = clock.timeline.timecode;
        entry.timecode = renderTimecode(timeline.ms, rate, dropFrame);
      }
    }
    entries.push(entry);
  };
  analysis.items.forEach((item, index) => {
    add(`/items/${index}/candidate/start`, item.candidate.start);
    add(`/items/${index}/candidate/end`, item.candidate.end);
    if (item.result.evidence?.timestamp) add(`/items/${index}/result/evidence/timestamp`, item.result.evidence.timestamp);
  });
  const code = clock?.timeline?.timecode;
  return {
    schemaVersion: 1, kind: "frame-of-mind.times", fileClock,
    ...(clock?.timeline ? { timeline: { timelineOffsetMs: clock.timeline.timelineOffsetMs, origin: clock.timeline.origin } } : {}),
    ...(code ? { timecodeRate: { ...code.rate, dropFrame: code.dropFrame, rateOrigin: code.rateOrigin } } : {}),
    entries,
  };
}
