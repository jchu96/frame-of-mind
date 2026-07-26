export const schemaSql = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS analysis_runs (
  run_id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL,
  meeting_title TEXT,
  provider TEXT NOT NULL CHECK (provider IN ('bluedot', 'granola', 'file')),
  transport TEXT NOT NULL CHECK (transport IN ('mcp', 'api', 'file')),
  recipe_id TEXT NOT NULL,
  recipe_label TEXT NOT NULL,
  model TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  match_notes TEXT NOT NULL,
  accepted_count INTEGER NOT NULL,
  rejected_count INTEGER NOT NULL,
  analysis_json TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  imported_by TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS analysis_runs_completed_at_idx
  ON analysis_runs (completed_at DESC);
CREATE INDEX IF NOT EXISTS analysis_runs_meeting_id_idx
  ON analysis_runs (meeting_id);

CREATE TABLE IF NOT EXISTS analysis_items (
  run_id TEXT NOT NULL REFERENCES analysis_runs(run_id) ON DELETE CASCADE,
  item_index INTEGER NOT NULL,
  accepted INTEGER NOT NULL CHECK (accepted IN (0, 1)),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  importance TEXT CHECK (importance IN ('high', 'medium', 'low')),
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  screenshot TEXT,
  candidate_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  PRIMARY KEY (run_id, item_index)
) STRICT;

CREATE INDEX IF NOT EXISTS analysis_items_kind_idx
  ON analysis_items (kind);
CREATE INDEX IF NOT EXISTS analysis_items_accepted_idx
  ON analysis_items (accepted);
`;

export const upsertRunSql = `
INSERT INTO analysis_runs (
  run_id, meeting_id, meeting_title, provider, transport, recipe_id,
  recipe_label, model, started_at, completed_at, match_notes, accepted_count,
  rejected_count, analysis_json, manifest_json, imported_at, imported_by
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(run_id) DO UPDATE SET
  meeting_id = excluded.meeting_id,
  meeting_title = excluded.meeting_title,
  provider = excluded.provider,
  transport = excluded.transport,
  recipe_id = excluded.recipe_id,
  recipe_label = excluded.recipe_label,
  model = excluded.model,
  started_at = excluded.started_at,
  completed_at = excluded.completed_at,
  match_notes = excluded.match_notes,
  accepted_count = excluded.accepted_count,
  rejected_count = excluded.rejected_count,
  analysis_json = excluded.analysis_json,
  manifest_json = excluded.manifest_json,
  imported_at = excluded.imported_at,
  imported_by = excluded.imported_by
`;

export const insertItemsFromJsonSql = `
INSERT INTO analysis_items (
  run_id, item_index, accepted, kind, title, summary, importance,
  start_time, end_time, screenshot, candidate_json, result_json
)
SELECT
  json_extract(value, '$.runId'),
  json_extract(value, '$.itemIndex'),
  json_extract(value, '$.result.accepted'),
  json_extract(value, '$.result.kind'),
  json_extract(value, '$.result.title'),
  json_extract(value, '$.result.summary'),
  coalesce(
    json_extract(value, '$.result.importance'),
    json_extract(value, '$.candidate.importance')
  ),
  json_extract(value, '$.candidate.start'),
  json_extract(value, '$.candidate.end'),
  json_extract(value, '$.screenshot'),
  json(json_extract(value, '$.candidate')),
  json(json_extract(value, '$.result'))
FROM json_each(?)
`;

export const runSummaryColumns = `
  run_id, meeting_id, meeting_title, provider, transport, recipe_id,
  recipe_label, model, started_at, completed_at, accepted_count,
  rejected_count, imported_at, imported_by
`;

export function importValues(input: {
  analysis: {
    meeting: { id: string; title?: string; provider: string };
    recipe: { id: string; label: string };
    model: string;
    matchNotes: string;
    items: Array<{ result: { accepted: boolean } }>;
  };
  manifest: {
    runId: string;
    contextTransport: string;
    startedAt: string;
    completedAt: string;
  };
}, actor?: string) {
  const acceptedCount = input.analysis.items.filter((item) => item.result.accepted).length;
  return [
    input.manifest.runId,
    input.analysis.meeting.id,
    input.analysis.meeting.title ?? null,
    input.analysis.meeting.provider,
    input.manifest.contextTransport,
    input.analysis.recipe.id,
    input.analysis.recipe.label,
    input.analysis.model,
    input.manifest.startedAt,
    input.manifest.completedAt,
    input.analysis.matchNotes,
    acceptedCount,
    input.analysis.items.length - acceptedCount,
    JSON.stringify(input.analysis),
    JSON.stringify(input.manifest),
    new Date().toISOString(),
    actor ?? null,
  ] as const;
}

interface ProjectionItem {
  candidate: {
    start: string;
    end: string;
    importance: "high" | "medium" | "low";
  };
  result: {
    accepted: boolean;
    kind: string;
    title: string;
    summary: string;
    importance?: "high" | "medium" | "low";
  };
  screenshot?: string;
}

export const MAX_D1_JSON_PARAMETER_BYTES = 900_000;
export const MAX_D1_RUN_ROW_BYTES = 1_800_000;

export class D1ProjectionLimitError extends Error {}

export function assertD1RunRowSize(
  input: Parameters<typeof importValues>[0],
  actor?: string,
): void {
  const encoder = new TextEncoder();
  const bytes = importValues(input, actor).reduce(
    (total, value) => total + (
      typeof value === "string" ? encoder.encode(value).byteLength : 8
    ),
    0,
  );
  if (bytes > MAX_D1_RUN_ROW_BYTES) {
    throw new D1ProjectionLimitError("Run bundle exceeds the D1 projection row limit.");
  }
}

export function itemJsonBatches(
  runId: string,
  items: ProjectionItem[],
): string[] {
  const rows = items.map((item, index) => JSON.stringify({
    runId,
    itemIndex: index,
    screenshot: item.screenshot ?? null,
    candidate: item.candidate,
    result: item.result,
  }));
  const encoder = new TextEncoder();
  const batches: string[] = [];
  let current: string[] = [];
  let currentBytes = 2;
  for (const row of rows) {
    const rowBytes = encoder.encode(row).byteLength;
    if (rowBytes + 2 > MAX_D1_JSON_PARAMETER_BYTES) {
      throw new D1ProjectionLimitError("One analysis item exceeds the D1 projection parameter limit.");
    }
    const separatorBytes = current.length ? 1 : 0;
    if (current.length && currentBytes + separatorBytes + rowBytes > MAX_D1_JSON_PARAMETER_BYTES) {
      batches.push(`[${current.join(",")}]`);
      current = [];
      currentBytes = 2;
    }
    current.push(row);
    currentBytes += (current.length > 1 ? 1 : 0) + rowBytes;
  }
  if (current.length) batches.push(`[${current.join(",")}]`);
  return batches;
}
