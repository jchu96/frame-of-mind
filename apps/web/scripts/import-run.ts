import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateVersionedRunImport } from "../../../src/domain/integrity";
import { createLocalRunStore } from "../server/data/sqlite";
import { LOCAL_SINGLE_USER_PRINCIPAL } from "../server/data/types";

const runDirectory = process.argv[2];
if (!runDirectory) {
  process.stderr.write("Usage: bun run web:import -- /path/to/run-directory\n");
  process.exitCode = 2;
} else {
  const directory = resolve(runDirectory);
  const [analysis, manifest] = await Promise.all([
    readFile(resolve(directory, "analysis.json"), "utf8").then(JSON.parse),
    readFile(resolve(directory, "manifest.json"), "utf8").then(JSON.parse),
  ]);
  const input = await validateVersionedRunImport({ analysis, manifest });
  const databasePath = resolve(process.env.NUXT_SQLITE_PATH || ".data/frame-of-mind.sqlite");
  const store = createLocalRunStore(databasePath, LOCAL_SINGLE_USER_PRINCIPAL);
  const result = await store.importRun(input, "local-cli");
  process.stdout.write(
    `${result.created ? "Imported" : "Refreshed"} ${result.runId} in ${databasePath}\n`,
  );
}
