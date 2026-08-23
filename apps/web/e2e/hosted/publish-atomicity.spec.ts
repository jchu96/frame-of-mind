import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { test, expect } from "@playwright/test";
import { analysisDigest } from "../../../../src/domain/integrity";
import { publishHostedRun } from "../../../workflows/src/publication";
import { videoRunFixture } from "../../test/fixtures";

test("publish step validates the pair and the partial-write fixture rolls back", async () => {
  const source = await readFile("apps/workflows/src/publication.ts", "utf8");
  const validation = source.indexOf("validateVersionedRunImport(pair)");
  const projection = source.indexOf("createD1RunStore", validation);
  expect(validation).toBeGreaterThan(-1);
  expect(projection).toBeGreaterThan(validation);

  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DB: `fom-e2e-publish-${crypto.randomUUID()}` },
  });
  try {
    const database = await miniflare.getD1Database("DB");
    for (const name of [
      "0001_initial.sql",
      "0002_video_only_projection.sql",
      "0003_principal_scope.sql",
    ]) {
      await applyMigration(
        database,
        await readFile(`apps/web/db/migrations/${name}`, "utf8"),
      );
    }
    const pair = await videoRunFixture();
    pair.analysis.runId = "20260823T120000Z-e2e-partial-write";
    pair.manifest.runId = pair.analysis.runId;
    pair.manifest.analysisSha256 = await analysisDigest(pair.analysis);
    await database.prepare(`
      CREATE TRIGGER reject_e2e_publication_item
      BEFORE INSERT ON video_analysis_items
      WHEN NEW.run_id = '${pair.analysis.runId}'
      BEGIN SELECT RAISE(ABORT, 'forced_e2e_partial_write'); END
    `).run();

    await expect(
      publishHostedRun(database as unknown as D1Database, "e2e-principal", pair),
    ).rejects.toThrow(/forced_e2e_partial_write/);
    for (const table of [
      "analysis_run_registry",
      "video_analysis_runs",
      "video_analysis_items",
    ]) {
      const row = await database.prepare(
        `SELECT count(*) AS count FROM ${table} WHERE principal_sub = ? AND run_id = ?`,
      ).bind("e2e-principal", pair.analysis.runId).first<{ count: number }>();
      expect(row?.count).toBe(0);
    }
  } finally {
    await miniflare.dispose();
  }
});

async function applyMigration(
  database: Awaited<ReturnType<Miniflare["getD1Database"]>>,
  sql: string,
): Promise<void> {
  await database.batch(sql.split(";").map((statement) => statement.trim())
    .filter(Boolean).map((statement) => database.prepare(statement)));
}
