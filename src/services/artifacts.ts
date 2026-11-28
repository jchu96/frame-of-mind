import { boundIndex, boundRate, humanTime, type Bound } from "../domain/source-bound.js";
import type { AnalysisItem } from "../domain/types.js";
import { declaredOffset, parseSecondsMs, type ClockDeclaration, type RunClock } from "../domain/clock.js";
import { modelTime, offsetApproximate, renderApproximate, deriveExact, offsetTime, snapDecimalSeconds, renderExactTimecode } from "exact-time";
import { timesSchema, type StoredSnap, type TimesArtifact } from "../domain/times.js";
import { decimalMs, describeMeasurement, describeSound, type Edge, type MeasuredTime, type SnapResult, type SnapRun } from "../domain/snap.js";
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
  proposals?: SnapRun,
): Promise<string[]> {
  if (analysis.schemaVersion !== manifest.schemaVersion && analysis.schemaVersion !== manifest.schemaVersion + 2) {
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
  const times = buildTimes(analysis, manifest.clock, proposals);
  const cuts = new Map<string, string>();
  if (times.schemaVersion === 3) for (const entry of times.entries) {
    if ("snap" in entry) cuts.set(entry.pointer, describeCut(entry));
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
  await writeFile(analysisMarkdown, renderAnalysis(analysis, validatedOutcome, manifest.clock, manifest.label, cuts, manifest.proseTimeUnverified), { mode: 0o600 });
  await writeFile(
    reportHtml,
    await renderHtmlArtifact(directory, analysis, manifest, validatedOutcome, cuts),
    { mode: 0o600 },
  );
  await writeFile(manifestJson, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  const timesJson = join(directory, "times.json");
  await writeFile(timesJson, `${JSON.stringify(times, null, 2)}\n`, { mode: 0o600 });
  return [analysisJson, outcomeJson, analysisMarkdown, reportHtml, manifestJson, timesJson];
}

export function renderAnalysis(
  analysis: VersionedAnalysisRun,
  outcome?: AnalysisOutcome,
  clock?: RunClock,
  label?: string,
  cuts?: ReadonlyMap<string, string>,
  proseWarning?: boolean,
): string {
  const accepted = analysis.items.map((item, originalIndex) => ({ item, originalIndex })).filter(({ item }) => item.result.accepted);
  const heading = "meeting" in analysis
    ? analysis.meeting.title || `Meeting ${analysis.meeting.id}`
    : label || "Video analysis";
  const contextLine = "meeting" in analysis
    ? `- Meeting: \`${escapeInline(analysis.meeting.id)}\``
    : "- Context: Video only (no external context)";
  const lines = [
    `# ${escapeInline(heading)}`,
    "",
    ...(label ? [`- Label: ${escapeInline(label)}`] : []),
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
    ...(proseWarning && !analysis.items.length ? ["A time in this text may be on the cut's clock."] : []),
    "",
  ];
  for (const [index, { item, originalIndex }] of accepted.entries()) {
    const result = item.result;
    lines.push(
      `## ${index + 1}. ${escapeInline(result.title)}`,
      "",
      `- Kind: ${escapeInline(result.kind)}`,
      `- Time: ${escapeInline(renderClockTime(result.evidence?.timestamp || item.candidate.start, clock, result.evidence?.exactTime ?? item.candidate.exactSpan?.start))}`,
      ...(item.stillTimes ? [`- ${escapeInline(stillTimesLine(item.stillTimes, clock))}`] : []),
      ...exactItemLines(item).map(line => `- ${escapeInline(line)}`),
      ...recordCuts(cuts, originalIndex).map(line => `- ${line}`),
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
        "meeting" in analysis ? "### Meeting quote" : "### Recording quote",
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
    if (item.screenshot && /^moment-\d+(?:-(?:video-frame|tick)-\d+)?\.png$/.test(basename(item.screenshot))) {
      lines.push(`![Screen evidence](./${basename(item.screenshot)})`, "");
    }
    if (result.confidenceNotes) lines.push(`_Confidence: ${escapeInline(result.confidenceNotes)}_`, "");
  }
  for (const line of rejectedStillLines(analysis, clock)) lines.push(escapeInline(line), "");
  if (!accepted.length) lines.push("No candidate survived the recipe interrogation pass.", "");
  return `${lines.filter((line, index) => line || lines[index - 1]).join("\n").trim()}\n`;
}

async function renderHtmlArtifact(
  directory: string,
  analysis: VersionedAnalysisRun,
  manifest: VersionedRunManifest,
  outcome: AnalysisOutcome,
  cuts: ReadonlyMap<string, string>,
): Promise<string> {
  const accepted = analysis.items.map((item, originalIndex) => ({ item, originalIndex })).filter(({ item }) => item.result.accepted);
  const cards = await Promise.all(accepted.map(async ({ item, originalIndex }, index) => {
    const result = item.result;
    let image = "";
    if (item.screenshot && /^moment-\d+(?:-(?:video-frame|tick)-\d+)?\.png$/.test(basename(item.screenshot))) {
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
    const positions = exactItemLines(item).map(text => `<p>${html(text)}</p>`).join("");
    const cutParagraphs = recordCuts(cuts, originalIndex).map(line => `<p>${html(line)}</p>`).join("");
    return `<article>
      <div class="eyebrow">${html(result.kind)} · ${html(result.importance || item.candidate.importance)} · ${html(renderClockTime(result.evidence?.timestamp || item.candidate.start, manifest.clock, result.evidence?.exactTime ?? item.candidate.exactSpan?.start))}</div>
      <h2>${index + 1}. ${html(result.title)}</h2>${item.stillTimes ? `\n      <p>${html(stillTimesLine(item.stillTimes, manifest.clock))}</p>` : ""}
      <p>${html(result.summary)}</p>${positions}${cutParagraphs ? `\n      ${cutParagraphs}` : ""}
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
  const heading = "meeting" in analysis
    ? analysis.meeting.title || `Meeting ${analysis.meeting.id}`
    : manifest.label || "Video analysis";
  const providerLabel = "meeting" in analysis
    ? analysis.meeting.provider
    : "video only";
  const safeSourceUrl = "meeting" in analysis
    ? safeHref(analysis.meeting.sourceUrl)
    : undefined;
  const source = safeSourceUrl
    ? `<a href="${htmlAttribute(safeSourceUrl)}" rel="noreferrer">Open source meeting</a>`
    : "meeting" in analysis
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
    <div class="meta">${manifest.label ? `<span>Label: ${html(manifest.label)}</span>` : ""}<span>${accepted.length} accepted record(s)</span><span>Model ${html(analysis.model)}</span><span>${source}</span></div>
  </header>
  ${outcomeNotice}
  ${manifest.proseTimeUnverified && !analysis.items.length ? "<p>A time in this text may be on the cut's clock.</p>\n  " : ""}<section><h2>Recording match</h2><p>${html(analysis.matchNotes || "No match notes returned.")}</p>
    <p class="muted">${alignment}</p>
  </section>
  ${cards.join("\n") || "<article><h2>No accepted records</h2><p>No candidate survived the recipe interrogation pass.</p></article>"}
  ${rejectedStillLines(analysis, manifest.clock).map(line => `<p>${html(line)}</p>`).join("\n")}<footer class="muted"><p>Portable review rendering. The versioned source of truth is <code>analysis.json</code>; run provenance is in <code>manifest.json</code>.</p></footer>
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
  return `clocks: ${clock?.fileClock ?? "source"}${clock?.timeline ? `, timeline offset ${renderDeclaredOffset(clock.timeline)}` : ""}; model clip clock: ${clock?.modelClipClock ?? "unverified"}${!clock || clock.modelClipClock === "unverified" ? " (clip clock unverified)" : ""}${clock?.clipGuard === "unknown-duration" ? "; clip guard did not run: duration unknown" : ""}${clock?.transcriptClock === "unverified" ? "; transcript clock unverified (legacy alignment retained)" : ""}${clock?.transcriptWindow === "not-windowed" ? "; transcript not windowed" : ""}`;
}

function renderDeclaredOffset(declaration: NonNullable<RunClock["timeline"]>): string {
  const time = deriveExact(declaredOffset(declaration), declaration.timecode?.dropFrame);
  const units = "frames" in time ? `${time.frames} frames @${time.rate.num}/${time.rate.den}; ${time.timecode} ${time.dropFrame ? "drop-frame" : "non-drop"}` : `${time.milliseconds} ms`;
  const seconds = time.seconds === undefined ? `derived seconds unavailable: ${time.secondsUnavailable}` : `${time.seconds} s (derived)`;
  return `${seconds} (${units}; ${"ticks" in time ? `${time.ticks} ticks` : time.ticksUnavailable}; declared)`;
}
function timelineTime(time: ReturnType<typeof modelTime>, offset: ReturnType<typeof declaredOffset>, bound?: Bound) {
  const timeline = offsetApproximate(time, offset);
  if (!bound) return timeline;
  const rate = boundRate(bound);
  const denominator = BigInt(rate.num) * BigInt(offset.rate.num);
  const numerator = boundIndex(bound) * BigInt(rate.den) * BigInt(offset.rate.num)
    + offset.frames * BigInt(offset.rate.den) * BigInt(rate.num);
  return {...timeline, seconds:decimalMs(Number(numerator * 1000n / denominator))};
}

export function renderClockTime(timestamp: string, clock?: RunClock, bound?: Bound): string {
  const time = modelTime(clock?.fileClock ?? "source", timestamp);
  const timeline = clock?.timeline && timelineTime(time, declaredOffset(clock.timeline), bound);
  return [renderApproximate(time), ...(timeline ? [renderApproximate(timeline)] : [])].join(" · ");
}

function stillTimesLine(times: readonly string[], clock?: RunClock): string {
  return `Stills (${clock?.fileClock ?? "source"}): ${times.join(", ") || "none"}`;
}

function describeBound(b: Bound) {
  const rate = boundRate(b);
  const support = b.origin === "model" ? `, support [${b.support.join(",")})` : b.origin === "snap" ? ", grid 10 ms" : "";
  return `${humanTime(b)} · source ${b.unit} ${boundIndex(b)} at ${rate.num}/${rate.den} Hz (${b.origin}, ${b.precisionMs} ms${support})`;
}
function exactItemLines(item: AnalysisItem) {
  const span = item.candidate.exactSpan, e = item.result.evidence?.exactTime;
  return [...(span ? [`Start ${describeBound(span.start)}`,`End (exclusive) ${describeBound(span.endExclusive)}`] : []),
    ...(e ? [`Evidence ${describeBound(e)}`] : []),...(item.exactStillTimes ?? []).map(b => `Still ${describeBound(b)}`),
    ...(item.screenshotExactTime ? [`Screenshot ${describeBound(item.screenshotExactTime)}`] : [])];
}
function rejectedStillLines(analysis: VersionedAnalysisRun, clock?: RunClock): string[] {
  return analysis.items.flatMap((item, i) => item.result.accepted ? [] :
    [...(item.stillTimes ? [`Rejected candidate ${i+1} · ${stillTimesLine(item.stillTimes,clock)}`] : []),
     ...exactItemLines(item).map(s => `Rejected candidate ${i+1} · ${s}`),
     ...(item.candidate.exactSpan && item.result.confidenceNotes ? [item.result.confidenceNotes] : [])]);
}

function recordCuts(cuts: ReadonlyMap<string, string> | undefined, index: number): string[] {
  return ["start", "end"].flatMap(edge => {
    const cut = cuts?.get(`/items/${index}/candidate/${edge}`);
    return cut ? [`Cut ${edge} · ${cut}`] : [];
  });
}

function describeCut(entry: { time: Parameters<typeof renderApproximate>[0]; snap: StoredSnap }) {
  const result = entry.snap;
  const parts = [renderApproximate(entry.time), result.status as string];
  if (result.status === "snapped") {
    parts.push(`${result.target.seconds} s ${result.target.clock} (${describeMeasurement(result.target)})`,
      `shift ${result.shiftMs} ms`, `pause ${result.gapLowerBound ? "≥" : ""}${result.gapMs} ms`);
    const sound = describeSound(result);
    if (sound) parts.push(sound);
    if (result.timeline) parts.push(`${result.timeline.seconds} s timeline (${describeMeasurement(result.timeline)})`);
    const ref = result.frameReference;
    if (ref) parts.push(`containing frame of the proposal: timeline ${ref.frames} at ${ref.rate.num}/${ref.rate.den}, ${ref.timecode} ${ref.dropFrame ? "DF" : "NDF"} (${ref.basis}), proposal uncertainty can span neighbouring frames`);
  }
  if ("alternativesMs" in result && result.alternativesMs.length) parts.push(`alternatives (${entry.time.clock} ms): ${result.alternativesMs.join(", ")}`);
  return parts.join(" · ");
}

function projectSnap(result: SnapResult, edge: Edge, declaration?: ClockDeclaration) {
  if (result.status !== "snapped" || !declaration) return result;
  const offset = declaredOffset(declaration);
  const target = result.target;
  const projected = { ...result, timeline: offsetApproximate(target, offset) };
  const spec = declaration.timecode;
  if (!spec) return projected;
  const instant = edge === "start" ? target.seconds : decimalMs(parseSecondsMs(target.seconds) - 1);
  const frame = offset.unit === "video-frame"
    ? offsetTime(snapDecimalSeconds(target.clock, instant, spec.rate, "instant"), offset)
    : snapDecimalSeconds("timeline", offsetApproximate({ ...target, seconds: instant }, offset).seconds, spec.rate, "instant");
  return { ...projected, frameReference: { clock: "timeline", frames: String(frame.frames), rate: spec.rate,
    dropFrame: spec.dropFrame, timecode: renderExactTimecode(frame, spec.dropFrame), basis: edge === "start" ? "onset" : "last-speech-ms" } };
}

export function buildTimes(analysis: VersionedAnalysisRun, clock?: RunClock, proposals?: SnapRun): TimesArtifact {
  const fileClock = clock?.fileClock ?? "source";
  const entries: unknown[] = [];
  const offset = clock?.timeline ? declaredOffset(clock.timeline) : undefined;
  const add = (pointer: string, timestamp: string, bound?: Bound, proposal?: ReturnType<typeof projectSnap>) => {
    const time = modelTime(fileClock, timestamp);
    const edge = pointer.endsWith("/end") ? "end" : "start";
    const measured = (ms: number, precisionMs: MeasuredTime["precisionMs"]): Bound => {
      const rate = boundRate(bound!), den = 1000n * BigInt(rate.den);
      // Label the containing frame at onset and at the last millisecond
      // of speech for an offset, as for the optional sequence view.
      const instant = edge === "end" ? Math.max(0, ms - 1) : ms;
      const n = String(BigInt(instant) * BigInt(rate.num) / den);
      const origin = {clock:"source" as const, origin:"snap" as const, gridMs:10 as const, precisionMs};
      return bound!.unit === "tick" ? {...origin, unit:"tick", ticks:n, tick:bound!.tick} : bound!.unit === "sample"
        ? {...origin,unit:"sample",samples:n,rate} : {...origin,unit:"video-frame",frames:n,rate};
    };
    const exactSnap = bound && proposal && "alternativesMs" in proposal ? {
      exactAlternatives: proposal.alternativesMs.map(ms => measured(ms,
        proposals?.noisyEdges?.[edge].has(ms) ? 300 : proposals?.precisionMs ?? 200)),
      ...(proposal.status === "snapped" && {exactTime: measured(parseSecondsMs(proposal.target.seconds), proposal.target.precisionMs)}),
    } : {};
    const timeline = offset && timelineTime(time, offset, bound);
    entries.push({ pointer, ...(bound && {exactTime:bound}), time: { ...time, origin: "model" },
      ...(timeline ? { timeline: { ...timeline, origin: "model" as const } } : {}),
      ...(proposal ? { snap: {...proposal,...exactSnap} } : {}) });
  };
  analysis.items.forEach((item, index) => {
    add(`/items/${index}/candidate/start`, item.candidate.start, item.candidate.exactSpan?.start, proposals && projectSnap(proposals.records[index]!.start, "start", clock?.timeline));
    add(`/items/${index}/candidate/end`, item.candidate.end, item.candidate.exactSpan?.endExclusive, proposals && projectSnap(proposals.records[index]!.end, "end", clock?.timeline));
    if (item.result.evidence?.timestamp) add(`/items/${index}/result/evidence/timestamp`, item.result.evidence.timestamp,item.result.evidence.exactTime);
  });
  return timesSchema.parse({
    schemaVersion: proposals ? 3 : 2, ...(proposals ? { snapSettings: proposals.settings } : {}), kind: "frame-of-mind.times", fileClock,
    exactTimeCapability: offset?.unit === "video-frame"
      ? "declared video rate: frames, timecode with explicit drop-frame, ticks when whole, derived seconds when a whole millisecond exists"
      : clock?.timeline?.timecode ? "legacy millisecond offset: milliseconds, seconds and ticks; no exact video-frame boundary"
      : "no declared video rate: whole milliseconds, seconds and ticks; no frames or timecode",
    ...(offset ? { timeline: { offset: { ...deriveExact(offset, clock?.timeline?.timecode?.dropFrame), origin: "declared" } } } : {}),
    entries,
  });
}
