import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { LOCAL_SINGLE_USER_PRINCIPAL } from "../domain/run-store.js";
import { sqliteRunLookup, sharedRunColumns, meetingColumns } from "./sqlite-run-lookup.js";
import { utcDateTimeSchema } from "../domain/schemas.js";
import { projectRun, RunQuery, ReadError } from "../services/run-query.js";

const maxBytes = 64 * 1024 * 1024;
const principal = LOCAL_SINGLE_USER_PRINCIPAL.principal;

function sameFile(a: BigIntStats, b: BigIntStats) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.ctimeNs === b.ctimeNs && a.mtimeNs === b.mtimeNs && a.mode === b.mode;
}

async function checkSidecars(path: string) {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try {
      await lstat(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    throw new ReadError("snapshot_not_closed");
  }
}

async function readSnapshotImage(path: string) {
  if (!isAbsolute(path) || resolve(path) !== path) throw new ReadError("bad_arguments");
  // UNC, device paths and NTFS streams can extend the grant beyond a local file.
  if (process.platform === "win32" && !/^[A-Za-z]:\\[^:]+$/.test(path)) throw new ReadError("unsafe_snapshot");
  if (await realpath(path) !== path) throw new ReadError("unsafe_snapshot");
  const directory = await lstat(dirname(path), { bigint: true });
  const before = await lstat(path, { bigint: true });
  if (!directory.isDirectory() || !before.isFile() || before.nlink !== 1n
    || (process.getuid && (directory.uid !== BigInt(process.getuid()) || (directory.mode & 0o022n) !== 0n))) {
    throw new ReadError("unsafe_snapshot");
  }
  if (before.size > BigInt(maxBytes)) throw new ReadError("snapshot_too_large");
  await checkSidecars(path);
  const fd = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    if (!sameFile(before, await fd.stat({ bigint: true }))) throw new ReadError("snapshot_changed");
    const image = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < image.length) {
      const { bytesRead } = await fd.read(image, offset, image.length - offset, offset);
      if (!bytesRead) throw new ReadError("snapshot_changed");
      offset += bytesRead;
    }
    await checkSidecars(path);
    if (!sameFile(before, await fd.stat({ bigint: true })) || !sameFile(before, await lstat(path, { bigint: true }))
      || !sameFile(directory, await lstat(dirname(path), { bigint: true })) || await realpath(path) !== path) {
      throw new ReadError("snapshot_changed");
    }
    if (image.length < 100 || image.toString("ascii", 0, 16) !== "SQLite format 3\0") throw new ReadError("invalid_projection");
    if (image[18] !== 1 || image[19] !== 1) throw new ReadError("snapshot_not_closed");
    return image;
  } finally {
    await fd.close();
  }
}

const itemColumns = "principal_sub, run_id, principal_email, item_index, accepted, kind, title, summary, importance, start_time, end_time, screenshot, candidate_json, result_json";
const requiredTables = {
  analysis_run_registry: "principal_sub, run_id, schema_version, principal_email",
  analysis_runs: sharedRunColumns + ", " + meetingColumns,
  video_analysis_runs: sharedRunColumns,
  analysis_items: itemColumns,
  video_analysis_items: itemColumns,
};

// Bun enables native extension loading only through the explicit loadExtension API.
// Refuse a SQLite build that also enables the SQL function. NULL names no library.
function verifyExtensionsDisabled(db: Database) {
  try {
    db.query("SELECT load_extension(NULL)").get();
  } catch (error) {
    if (error instanceof Error && /no such function|not authorized/i.test(error.message)) return;
    throw error;
  }
  throw new ReadError("invalid_projection");
}

function verifyTables(db: Database) {
  for (const [table, fields] of Object.entries(requiredTables)) {
    const definition = db.query<{ sql: string }, [string]>(
      "SELECT sql FROM main.sqlite_schema WHERE name = ? AND type = 'table'",
    ).get(table);
    if (!definition || !/^CREATE TABLE\s/i.test(definition.sql)) throw new ReadError("invalid_projection");
    const columns = db.query<{ name: string; type: string; hidden: number; pk: number }, []>(
      `PRAGMA main.table_xinfo(${table})`,
    ).all();
    if (columns.some(c => c.hidden !== 0) || fields.split(", ").some(name => {
      const col = columns.find(c => c.name === name);
      const type = ["schema_version", "accepted_count", "rejected_count", "item_index", "accepted"].includes(name) ? "INTEGER" : "TEXT";
      const key = name === "principal_sub" ? 1 : name === "run_id" ? 2 : name === "item_index" ? 3 : 0;
      return !col || col.type !== type || col.pk !== key;
    })) {
      throw new ReadError("invalid_projection");
    }
  }
}

export async function openRunSnapshot(path: string): Promise<RunQuery> {
  let image;
  try {
    image = await readSnapshotImage(path);
  } catch (error) {
    if (error instanceof ReadError) throw error;
    throw new ReadError("unsafe_snapshot");
  }
  const { Database } = await import("bun:sqlite");
  const db = Database.deserialize(image, true);
  try {
    db.exec("PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY; PRAGMA query_only=ON;");
    verifyExtensionsDisabled(db);
    verifyTables(db);
    const registrations = db.query<{ run_id: string; schema_version: number }, [string]>(
      "SELECT run_id, schema_version FROM main.analysis_run_registry NOT INDEXED WHERE principal_sub COLLATE BINARY = ?",
    ).all(principal);
    const versions = new Map(registrations.map(row => [row.run_id, row.schema_version]));
    if (versions.size !== registrations.length) throw new ReadError("invalid_projection");
    // Enumerate physical identities independently so that an orphan, unsupported version or
    // duplicate cannot disappear behind a JSON predicate before it contributes to a facet.
    const unmatched = new Map(versions);
    for (const [version, table] of [[2, "analysis_runs"], [3, "video_analysis_runs"]] as const) {
      const rows = db.query<{ run_id: string }, [string]>(
        `SELECT run_id FROM main.${table} NOT INDEXED WHERE principal_sub COLLATE BINARY = ?`,
      ).iterate(principal);
      for (const { run_id } of rows) {
        if (unmatched.get(run_id) !== version) throw new ReadError("invalid_projection");
        unmatched.delete(run_id);
      }
    }
    if (unmatched.size) throw new ReadError("invalid_projection");
    const store = sqliteRunLookup(db, LOCAL_SINGLE_USER_PRINCIPAL, versions);
    const runs = [];
    for (const id of versions.keys()) {
      const run = await store.getRun(id);
      if (!run) throw new ReadError("invalid_projection");
      utcDateTimeSchema.parse(run.importedAt);
      runs.push(projectRun(run));
    }
    return new RunQuery(runs);
  } finally {
    db.close();
  }
}
