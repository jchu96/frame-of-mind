import {
  cp,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { checkCloudflareBoundary } from "./check-cloudflare-boundary";
import { createE2EEnvironment } from "./e2e-environment";
import { createE2EIsolation } from "../apps/web/e2e/support/isolation";
import {
  resolvePrebuiltWebOutput,
  resolvePrebuiltWorkflowsOutput,
} from "./prebuilt-artifact";

const startedAt = performance.now();
const repositoryRoot = resolve(import.meta.dir, "..");
const isolation = await createE2EIsolation("hosted-release");
const temporaryRoot = isolation.root;
const previousOutput = join(temporaryRoot, "previous-output");
const prebuiltOutput = await resolvePrebuiltWebOutput("cloudflare_module");
const prebuiltWorkflows = await resolvePrebuiltWorkflowsOutput();
const webOutput = prebuiltOutput
  ?? resolve(repositoryRoot, "apps/web/.output");
const rollbackOutput = prebuiltOutput ?? previousOutput;
const workflowMain = prebuiltWorkflows
  ? join(prebuiltWorkflows, "index.js")
  : resolve(repositoryRoot, "apps/workflows/src/index.ts");
const migrationDirectory = join(temporaryRoot, "migrations-0001-through-0009");
const persistRoot = isolation.persistRoot;
const wranglerBin = resolve(repositoryRoot, "apps/web/node_modules/wrangler/bin/wrangler.js");
const databaseName = isolation.databaseName;
const databaseId = isolation.databaseId;
const safeEnvironment = createE2EEnvironment(process.env);

try {
  if (prebuiltOutput) {
    console.log("HOSTED_RELEASE build=SKIP prebuilt=cloudflare_module");
  } else {
    await runChecked(
      ["bun", "--no-env-file", "run", "--cwd", "apps/web", "build:cloudflare:review"],
      "previous review-only Cloudflare build",
    );
    await cp(resolve(repositoryRoot, "apps/web/.output"), previousOutput, { recursive: true });

    await runChecked(
      ["bun", "--no-env-file", "run", "--cwd", "apps/web", "build:cloudflare"],
      "hosted production Cloudflare build",
    );
  }
  const firstEntry = await readFile(
    join(webOutput, "server/hosted-entry.mjs"),
  );
  const secondEntry = prebuiltOutput
    ? await readFile(resolve(repositoryRoot, "scripts/hosted-entry.mjs"))
    : await (async () => {
        await runChecked(
          ["bun", "--no-env-file", "scripts/build-hosted-entry.ts"],
          "deterministic hosted entry replay",
        );
        return readFile(join(webOutput, "server/hosted-entry.mjs"));
      })();
  if (!firstEntry.equals(secondEntry)) {
    throw new Error("hosted-entry.mjs changed across identical emission inputs.");
  }
  console.log(`HOSTED_RELEASE entry_determinism=PASS bytes=${secondEntry.byteLength}`);
  await runChecked(
    ["bun", "--no-env-file", "scripts/test-hosted-entry.ts"],
    "hosted entry delegation contract",
  );
  console.log("HOSTED_RELEASE entry=PASS mode=delegating body_read=false");

  const boundary = await checkCloudflareBoundary(
    webOutput,
  );
  console.log(
    `HOSTED_RELEASE boundary=PASS required=${boundary.requiredMarkers} `
    + `forbidden=${boundary.forbiddenMarkers}`,
  );
  await runChecked(
    ["bun", "--no-env-file", "scripts/test-cloudflare-boundary.ts"],
    "Cloudflare boundary fixture self-test",
  );

  const publicShape = await readJson("apps/web/wrangler.jsonc.example");
  const workflowShape = await readJson("apps/workflows/wrangler.jsonc.example");
  validateConfigShapes(publicShape, workflowShape);
  validateHostedAuthConfig(publicShape.vars as Record<string, unknown> | undefined);
  for (const invalid of [undefined, { NUXT_AUTH_MODE: "unknown-mode" }]) {
    try {
      validateHostedAuthConfig(invalid);
      throw new Error("Hosted auth rehearsal accepted an unset or unknown mode.");
    } catch (error) {
      if (!(error instanceof Error) || !error.message.toLowerCase().includes("hosted auth mode")) {
        throw error;
      }
    }
  }
  console.log("HOSTED_RELEASE auth_config=PASS explicit_mode_required=true unknown_refused=true");
  console.log("HOSTED_RELEASE bindings=PASS public=DB,ASSETS,HOSTED_WORKFLOWS workflow=DB,HOSTED_WORKFLOW");

  const publicConfig = join(temporaryRoot, "public.wrangler.json");
  const workflowConfig = join(temporaryRoot, "workflow.wrangler.json");
  const rollbackConfig = join(temporaryRoot, "rollback.wrangler.json");
  await writeFile(publicConfig, JSON.stringify({
    ...publicShape,
    name: "frame-of-mind-hosted-release-rehearsal",
    main: join(webOutput, "server/hosted-entry.mjs"),
    routes: undefined,
    assets: {
      directory: join(webOutput, "public"),
      binding: "ASSETS",
    },
    d1_databases: [d1Binding(resolve(repositoryRoot, "apps/web/db/migrations"))],
    services: [{
      binding: "HOSTED_WORKFLOWS",
      service: "frame-of-mind-hosted-workflows-rehearsal",
    }],
  }, null, 2));
  await writeFile(workflowConfig, JSON.stringify({
    ...workflowShape,
    name: "frame-of-mind-hosted-workflows-rehearsal",
    main: workflowMain,
    d1_databases: [d1Binding(resolve(repositoryRoot, "apps/web/db/migrations"))],
  }, null, 2));
  await writeFile(rollbackConfig, JSON.stringify({
    ...publicShape,
    name: "frame-of-mind-hosted-rollback-rehearsal",
    main: join(rollbackOutput, "server/index.mjs"),
    routes: undefined,
    assets: { directory: join(rollbackOutput, "public"), binding: "ASSETS" },
    d1_databases: [d1Binding(resolve(repositoryRoot, "apps/web/db/migrations"))],
    services: undefined,
    vars: {
      NUXT_AUTH_MODE: "cloudflare-access",
      NUXT_CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://rehearsal.cloudflareaccess.com",
      NUXT_CLOUDFLARE_ACCESS_AUD: "rehearsal-audience",
    },
  }, null, 2));

  const publicDryRun = await wranglerDryRun(publicConfig, join(temporaryRoot, "public-bundle"));
  assertDryRun(publicDryRun, ["DB", "ASSETS", "HOSTED_WORKFLOWS"], "public Worker");
  printDryRunReceipt(publicDryRun, "public", ["Total Upload", "ASSETS", "DB", "HOSTED_WORKFLOWS"]);
  console.log("HOSTED_RELEASE dry_run=PASS worker=public error_100329=false");
  const workflowDryRun = await wranglerDryRun(
    workflowConfig,
    join(temporaryRoot, "workflow-bundle"),
  );
  assertDryRun(workflowDryRun, ["DB", "HOSTED_WORKFLOW"], "Workflows Worker");
  printDryRunReceipt(workflowDryRun, "workflow", ["Total Upload", "DB", "HOSTED_WORKFLOW"]);
  console.log("HOSTED_RELEASE dry_run=PASS worker=workflow error_100329=false");

  await mkdir(migrationDirectory, { recursive: true });
  for (const name of [
    "0001_initial.sql",
    "0002_video_only_projection.sql",
    "0003_principal_scope.sql",
    "0004_hosted_workflows.sql",
    "0005_hosted_spend_telemetry.sql",
    "0006_better_auth.sql",
    "0007_hosted_direct_media.sql",
    "0008_hosted_retention_evidence.sql",
    "0009_magic_link_cooldown.sql",
  ]) {
    await cp(
      resolve(repositoryRoot, "apps/web/db/migrations", name),
      join(migrationDirectory, name),
    );
  }
  const migrationConfig = join(temporaryRoot, "migration.wrangler.json");
  await writeFile(migrationConfig, JSON.stringify({
    name: "frame-of-mind-hosted-migration-rehearsal",
    main: workflowMain,
    compatibility_date: "2026-08-18",
    compatibility_flags: ["nodejs_compat"],
    d1_databases: [d1Binding(migrationDirectory)],
  }, null, 2));
  const migrationCommand = [
    "node", wranglerBin, "d1", "migrations", "apply", databaseName,
    "--local", "--config", migrationConfig, "--persist-to", persistRoot,
  ];
  const firstMigration = await runChecked(migrationCommand, "D1 0001 through 0009 migration");
  for (const name of ["0001_initial.sql", "0002_video_only_projection.sql", "0003_principal_scope.sql", "0004_hosted_workflows.sql", "0005_hosted_spend_telemetry.sql", "0006_better_auth.sql", "0007_hosted_direct_media.sql", "0008_hosted_retention_evidence.sql", "0009_magic_link_cooldown.sql"]) {
    if (!firstMigration.includes(name)) throw new Error(`D1 rehearsal omitted ${name}.`);
  }
  const replayMigration = await runChecked(migrationCommand, "D1 migration replay");
  if (!/no migrations to apply/i.test(replayMigration)) {
    throw new Error("D1 migration replay did not report an idempotent no-op.");
  }
  console.log("HOSTED_RELEASE migrations=PASS range=0001..0009 replay=idempotent");

  await runChecked(
    [
      "bun", "test", "apps/web/test/sqlite.test.ts", "--test-name-pattern",
      "imports, lists, reads, and refreshes a run",
    ],
    "local byte-stable import regression",
  );
  console.log("HOSTED_RELEASE local_import=PASS bytes=stable");

  const rollbackDryRun = await wranglerDryRun(
    rollbackConfig,
    join(temporaryRoot, "rollback-bundle"),
  );
  assertDryRun(rollbackDryRun, ["DB", "ASSETS"], "previous public Worker");
  await verifyRollbackDocumentation();
  console.log("HOSTED_RELEASE rollback=PASS artifact=previous migration_down=backup_restore");

  const elapsedSeconds = (performance.now() - startedAt) / 1_000;
  console.log(`HOSTED_RELEASE runtime_seconds=${elapsedSeconds.toFixed(2)}`);
  console.log("HOSTED_RELEASE_REHEARSAL PASSED");
} finally {
  await isolation.cleanup();
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(resolve(repositoryRoot, path), "utf8"));
}

function validateConfigShapes(
  publicShape: Record<string, unknown>,
  workflowShape: Record<string, unknown>,
): void {
  if (publicShape.main !== ".output/server/hosted-entry.mjs") {
    throw new Error("Public Wrangler shape does not use hosted-entry.mjs.");
  }
  const assets = publicShape.assets as { binding?: string } | undefined;
  const publicD1 = publicShape.d1_databases as Array<{ binding?: string }> | undefined;
  const services = publicShape.services as Array<{ binding?: string }> | undefined;
  if (assets?.binding !== "ASSETS" || publicD1?.[0]?.binding !== "DB" || services?.[0]?.binding !== "HOSTED_WORKFLOWS") {
    throw new Error("Public Wrangler shape is missing ASSETS, DB, or HOSTED_WORKFLOWS.");
  }
  if (JSON.stringify(publicShape).includes("GEMINI_API_KEY")) {
    throw new Error("Public Wrangler shape names a Gemini secret.");
  }
  const workflowD1 = workflowShape.d1_databases as Array<{ binding?: string }> | undefined;
  const workflows = workflowShape.workflows as Array<{ binding?: string; class_name?: string }> | undefined;
  if (
    workflowD1?.[0]?.binding !== "DB"
    || workflows?.[0]?.binding !== "HOSTED_WORKFLOW"
    || workflows?.[0]?.class_name !== "HostedAnalysisWorkflow"
  ) {
    throw new Error("Workflow Wrangler shape is missing DB or HOSTED_WORKFLOW.");
  }
  // The Workflows Worker has no Access check of its own; it must never be
  // published on *.workers.dev (Wrangler's default when no routes exist).
  if (workflowShape.workers_dev !== false) {
    throw new Error("Workflow Wrangler shape must pin workers_dev: false.");
  }
  if (/SENTRY_DSN|GRANOLA|BLUEDOT/.test(JSON.stringify(workflowShape))) {
    throw new Error("Workflow production shape names a disallowed Tier A secret.");
  }
}

function validateHostedAuthConfig(vars: Record<string, unknown> | undefined): void {
  const mode = typeof vars?.NUXT_AUTH_MODE === "string" ? vars.NUXT_AUTH_MODE.trim() : "";
  if (![
    "cloudflare-access",
    "better-auth",
    "cloudflare-access+better-auth",
  ].includes(mode)) {
    throw new Error("Hosted auth mode must be explicit and recognized.");
  }
  if (mode.includes("cloudflare-access")) {
    if (!vars?.NUXT_CLOUDFLARE_ACCESS_TEAM_DOMAIN || !vars.NUXT_CLOUDFLARE_ACCESS_AUD) {
      throw new Error("Hosted auth mode cloudflare-access requires its domain and audience.");
    }
  }
}

function d1Binding(migrationsDirectory: string) {
  return {
    binding: "DB",
    database_name: databaseName,
    database_id: databaseId,
    migrations_dir: migrationsDirectory,
  };
}

async function wranglerDryRun(config: string, outdir: string): Promise<string> {
  return runChecked(
    ["node", wranglerBin, "deploy", "--dry-run", "--config", config, "--outdir", outdir],
    `Wrangler dry run for ${config}`,
  );
}

function assertDryRun(output: string, markers: string[], label: string): void {
  if (output.includes("100329")) throw new Error(`${label} reproduced Wrangler error 100329.`);
  for (const marker of markers) {
    if (!output.includes(marker)) throw new Error(`${label} dry run omitted ${marker}.`);
  }
}

function printDryRunReceipt(output: string, label: string, markers: string[]): void {
  for (const line of output.split(/\r?\n/)) {
    if (markers.some((marker) => line.includes(marker))) {
      console.log(`HOSTED_RELEASE_WRANGLER ${label} ${line.trim()}`);
    }
  }
}

async function verifyRollbackDocumentation(): Promise<void> {
  const deployment = await readFile(
    resolve(repositoryRoot, "docs/CLOUDFLARE_DEPLOYMENT.md"),
    "utf8",
  );
  const normalizedDeployment = deployment.replace(/\s+/g, " ");
  for (const marker of [
    "D1 has no down migrations",
    "wrangler d1 export",
    "previous known-good artifact",
  ]) {
    if (!normalizedDeployment.includes(marker)) {
      throw new Error(`Cloudflare rollback documentation is missing: ${marker}.`);
    }
  }
}

async function runChecked(command: string[], label: string): Promise<string> {
  const child = Bun.spawn(command, {
    cwd: repositoryRoot,
    env: safeEnvironment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const output = `${stdout}\n${stderr}`;
  if (exitCode !== 0) {
    throw new Error(`${label} failed (${exitCode}):\n${output}`);
  }
  return output;
}
