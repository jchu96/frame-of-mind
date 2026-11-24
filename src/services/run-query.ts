import { createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import type { StoredRun } from "../domain/run-store.js";
import { contextProviderSchema, importanceSchema, runIdSchema, utcDateTimeSchema } from "../domain/schemas.js";
import { timesV2Schema } from "../domain/times.js";
import { VERSION } from "../version.js";
import { buildTimes } from "./artifacts.js";

type ErrorCode = "bad_arguments" | "bad_cursor" | "unknown_tool" | "run_not_found" | "result_too_large"
  | "use_list_records" | "invalid_projection" | "unsafe_snapshot" | "snapshot_changed" | "snapshot_too_large" | "snapshot_not_closed";
export class ReadError extends Error {
  constructor(readonly code: ErrorCode) { super(code); }
}

const runId = runIdSchema.refine(id => id !== "." && id !== ".." && !/^[a-z]:/i.test(id));
const pageOptions = {
  limit: z.number().int().min(1).max(100).default(20),
  cursor: z.string().max(1024).optional(),
};
const textFilter = z.string().min(1).max(120);
const runList = z.strictObject({
  provider: contextProviderSchema.optional(), recipeId: textFilter.optional(),
  completedAfter: utcDateTimeSchema.optional(), completedBefore: utcDateTimeSchema.optional(), ...pageOptions,
});
const recordList = z.strictObject({
  runId, accepted: z.boolean().default(true), kind: textFilter.optional(), importance: importanceSchema.optional(), ...pageOptions,
});
const getRun = z.strictObject({ runId, includeRejected: z.boolean().default(false) });
const noArgs = z.strictObject({});
const timesNote = "Base times only. Schema 3 speech-edge proposal data is outside this projection.";
const retention = "This process reads an operator-selected local snapshot and stores no results.";
const bytesLimit = 256 * 1024;

const summary = z.strictObject({
  runId, schemaVersion: z.literal([2, 3]), contextMode: z.enum(["meeting", "none"]),
  provider: contextProviderSchema.optional(), recipeId: z.string(), startedAt: utcDateTimeSchema, completedAt: utcDateTimeSchema,
  acceptedCount: z.int().nonnegative(), rejectedCount: z.int().nonnegative(),
});
const provenance = z.strictObject({
  schemaVersion: z.literal([2, 3]), runId, startedAt: utcDateTimeSchema, completedAt: utcDateTimeSchema,
  recipe: z.strictObject({ id: z.string(), custom: z.boolean() }),
  remoteFile: z.strictObject({ deleted: z.boolean() }).optional(),
  contextProvider: contextProviderSchema.optional(), contextTransport: z.enum(["file", "api", "mcp"]).optional(),
  context: z.strictObject({ mode: z.literal("none") }).optional(),
});
const records = z.array(z.strictObject({
  itemIndex: z.int().nonnegative(), accepted: z.boolean(), kind: z.string(), title: z.string(), summary: z.string(),
  importance: importanceSchema, start: z.string(), end: z.string(), evidenceTimestamp: z.string().optional(),
}));
const recordPage = { records, times: timesV2Schema, timesNote: z.literal(timesNote) };
const nextCursor = z.string().max(1024).optional();
function parse<T>(schema: z.ZodType<T>, args: unknown): T {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    if (parsed.error.issues.some(issue => issue.path[0] === "cursor")) throw new ReadError("bad_cursor");
    throw new ReadError("bad_arguments");
  }
  return parsed.data;
}

// Operator review covers arbitrary prose. Recognizable credentials and local paths also
// invalidate a snapshot, including when they occur in a rejected record or a facet.
const credentialPatterns = [
  /\b(?:Bearer|Basic)\s+[\w+/=.-]+/i,
  /\b(?:AIza[\w-]{20,}|AKIA[A-Z0-9]{16}|gh[pousr]_\w+|github_pat_\w+|xox[baprs]-\S+|sk-[\w-]{16,}|eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+)/,
  /\b(?:password|(?:[\w]+_)?api[_-]?key|(?:access|refresh)[_-]?token|secret)\s*[:=]\s*\S+/i,
  /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/,
];
const localPath = /\bfile:\/\/|\b[a-z]:[\\/]|\\\\[^\s]|(?:^|[\s("'=:\[\x60])(?:~|\.{1,2})?[\\/][^\s/]/i;

function checkPublicText(text: string) {
  const urls = /https?:\/\/[^\s<>"']+/gi;
  if (credentialPatterns.some(pattern => pattern.test(text)) || localPath.test(text.replace(urls, " "))) {
    throw new ReadError("invalid_projection");
  }
  for (const [raw] of text.matchAll(urls)) {
    const url = new URL(raw);
    if (url.username || url.password || [...url.searchParams.keys()].some(key =>
      /signature|credential|token|^sig$|^key$|^api[_-]?key$|^key-pair-id$|^googleaccessid$/i.test(key))) {
      throw new ReadError("invalid_projection");
    }
  }
}

// The UTC validator accepts arbitrary fractional seconds. Compare instants without losing sub-millisecond precision.
function instant(value: string) {
  const [whole, fraction = ""] = value.slice(0, -1).split(".");
  return whole!.padEnd(19, ":00") + "." + fraction.replace(/0+$/, "");
}
function compare(a: string, b: string) { return a < b ? -1 : a > b ? 1 : 0; }

export function projectRun(stored: Pick<StoredRun, "analysis" | "manifest" | "contextMode" | "importedAt">) {
  const { manifest, analysis } = stored;
  if (!runId.safeParse(manifest.runId).success) throw new ReadError("invalid_projection");
  checkPublicText(manifest.runId);
  checkPublicText(manifest.recipe.id);
  const records = analysis.items.map(({ result, candidate }, itemIndex) => {
    const { accepted, kind, title, summary } = result;
    for (const text of [kind, title, summary]) checkPublicText(text);
    return { itemIndex, accepted, kind, title, summary, importance: result.importance ?? candidate.importance,
      start: candidate.start, end: candidate.end, ...(result.evidence?.timestamp && { evidenceTimestamp: result.evidence.timestamp }) };
  });
  const acceptedCount = records.filter(record => record.accepted).length;
  const { runId: id, startedAt, completedAt, schemaVersion } = manifest;
  const common = { runId: id, startedAt, completedAt, schemaVersion };
  const times = buildTimes(analysis, manifest.clock);
  if (times.schemaVersion !== 2) throw new ReadError("invalid_projection");
  return {
    summary: { ...common, contextMode: stored.contextMode, ...(manifest.schemaVersion === 2 && { provider: manifest.contextProvider }),
      recipeId: manifest.recipe.id, acceptedCount, rejectedCount: records.length - acceptedCount },
    provenance: { ...common, recipe: { id: manifest.recipe.id, custom: manifest.recipe.custom },
      ...(manifest.remoteFile && { remoteFile: { deleted: manifest.remoteFile.deleted } }),
      ...(manifest.schemaVersion === 2 ? { contextProvider: manifest.contextProvider, contextTransport: manifest.contextTransport } : { context: { mode: "none" as const } }) },
    records, times, completed: instant(completedAt), imported: instant(stored.importedAt),
  };
}

type ProjectedRun = ReturnType<typeof projectRun>;
type PublicRecord = ProjectedRun["records"][number];
function recordData(run: ProjectedRun, records: PublicRecord[]) {
  const indices = new Set(records.map(record => record.itemIndex));
  const entries = run.times.entries.filter(e => indices.has(Number(e.pointer.split("/")[2])));
  return { records, times: { ...run.times, entries }, timesNote };
}
function wrap(data: object) { return { trust: "untrusted-data" as const, data }; }
function fits(data: object) { return Buffer.byteLength(JSON.stringify(wrap(data))) <= bytesLimit; }

export class RunQuery {
  private readonly key = randomBytes(32);
  private readonly byId: Map<string, ProjectedRun>;
  constructor(private readonly runs: ProjectedRun[]) {
    runs.sort((a, b) => compare(b.completed, a.completed) || compare(b.imported, a.imported) || compare(b.summary.runId, a.summary.runId));
    this.byId = new Map(runs.map(run => [run.summary.runId, run]));
  }

  call(tool: string, args: unknown) {
    if (!Object.hasOwn(readTools, tool)) throw new ReadError("unknown_tool");
    const data = readTools[tool as keyof typeof readTools].invoke(this, args);
    if (!fits(data)) throw new ReadError("result_too_large");
    return wrap(data);
  }

  getRun({ runId, includeRejected }: z.infer<typeof getRun>) {
    const run = this.find(runId);
    const selected = run.records.filter(r => includeRejected || r.accepted);
    const data = { run: run.summary, provenance: run.provenance, ...recordData(run, selected) };
    if (!fits(data)) throw new ReadError("use_list_records");
    return data;
  }

  listRuns({ limit, cursor, ...filters }: z.infer<typeof runList>) {
    const after = filters.completedAfter && instant(filters.completedAfter);
    const before = filters.completedBefore && instant(filters.completedBefore);
    if (after && before && after >= before) throw new ReadError("bad_arguments");
    const rows = this.runs.filter(r => (!after || r.completed > after) && (!before || r.completed < before)
      && (!filters.provider || r.summary.provider === filters.provider) && (!filters.recipeId || r.summary.recipeId === filters.recipeId));
    return this.page(rows, limit, cursor, ["runs", filters], r => [r.completed, r.imported, r.summary.runId],
      page => ({ runs: page.map(r => r.summary) }));
  }

  listRecords({ limit, cursor, ...filters }: z.infer<typeof recordList>) {
    const run = this.find(filters.runId);
    const rows = run.records.filter(r => r.accepted === filters.accepted && (!filters.kind || r.kind === filters.kind)
      && (!filters.importance || r.importance === filters.importance));
    return this.page(rows, limit, cursor, ["records", filters], r => r.itemIndex, page => recordData(run, page));
  }

  private find(id: string) {
    const run = this.byId.get(id);
    if (!run) throw new ReadError("run_not_found");
    return run;
  }

  manifest() {
    const kinds = new Set<string>();
    const providers = new Set<string>();
    const recipes = new Set<string>();
    let itemCount = 0;
    for (const { summary, records } of this.runs) {
      recipes.add(summary.recipeId);
      if (summary.provider) providers.add(summary.provider);
      itemCount += summary.acceptedCount;
      for (const r of records) if (r.accepted) kinds.add(r.kind);
    }
    const sorted = (values: Set<string>) => [...values].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    return { serverVersion: VERSION, schemaVersions: { analysis: [2, 3], manifest: [2, 3], times: [2] },
      recipeIds: sorted(recipes), providers: sorted(providers), kinds: sorted(kinds),
      runCount: this.runs.length, itemCount, capabilities: { screenshotBytes: false }, retention };
  }

  private page<T>(rows: T[], limit: number, cursor: string | undefined, scope: unknown[], sortKey: (row: T) => unknown,
    project: (rows: T[]) => object): object {
    const token = (end: number) => end + "." + createHmac("sha256", this.key)
      .update(JSON.stringify([scope, end, sortKey(rows[end - 1]!)])).digest("base64url");
    let start = 0;
    if (cursor !== undefined) {
      if (cursor.length > 1024 || !/^[1-9]\d{0,9}\.[\w-]{43}$/.test(cursor)) throw new ReadError("bad_cursor");
      start = Number(cursor.split(".")[0]);
      if (start >= rows.length || token(start) !== cursor) throw new ReadError("bad_cursor");
    }
    if (start === rows.length) return project([]);
    // Find the largest whole-row page that fits, counting its continuation in the byte budget.
    let low = start + 1;
    let high = Math.min(rows.length, start + limit);
    let best: object | undefined;
    while (low <= high) {
      const end = Math.floor((low + high) / 2);
      const data = { ...project(rows.slice(start, end)), ...(end < rows.length && { nextCursor: token(end) }) };
      if (fits(data)) { best = data; low = end + 1; } else high = end - 1;
    }
    if (!best) throw new ReadError("result_too_large");
    return best;
  }
}

const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export const readTools = {
  frame_of_mind_v1_manifest: {
    annotations: readAnnotations,
    description: "Reads only. Discover reviewed runs and facets of their accepted records.", input: noArgs,
    invoke: (q: RunQuery, args: unknown) => { parse(noArgs, args); return q.manifest(); },
    output: z.strictObject({
      serverVersion: z.string(), schemaVersions: z.strictObject({
        analysis: z.tuple([z.literal(2), z.literal(3)]), manifest: z.tuple([z.literal(2), z.literal(3)]), times: z.tuple([z.literal(2)]),
      }),
      recipeIds: z.array(z.string()), providers: z.array(contextProviderSchema), kinds: z.array(z.string()),
      runCount: z.int(), itemCount: z.int(), capabilities: z.strictObject({ screenshotBytes: z.literal(false) }), retention: z.literal(retention),
    }),
  },
  frame_of_mind_v1_list_runs: {
    annotations: readAnnotations,
    description: "Reads only. Page reviewed run summaries by completion time, newest first.", input: runList,
    invoke: (q: RunQuery, args: unknown) => q.listRuns(parse(runList, args)),
    output: z.strictObject({ runs: z.array(summary), nextCursor }),
  },
  frame_of_mind_v1_get_run: {
    annotations: readAnnotations,
    description: "Reads only. Read one run, provenance, and original record times. Rejected records require includeRejected.", input: getRun,
    invoke: (q: RunQuery, args: unknown) => q.getRun(parse(getRun, args)),
    output: z.strictObject({ run: summary, provenance, ...recordPage }),
  },
  frame_of_mind_v1_list_records: {
    annotations: readAnnotations,
    description: "Reads only. Page records in original index order. Set accepted to false for rejected records.", input: recordList,
    invoke: (q: RunQuery, args: unknown) => q.listRecords(parse(recordList, args)),
    output: z.strictObject({ ...recordPage, nextCursor }),
  },
};
