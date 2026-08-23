import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from "jose";
import { validateVersionedRunImport } from "../src/domain/integrity";
import {
  GeminiVideoAnalyzer,
  MODEL_REQUEST_TIMEOUT_MS,
} from "../src/adapters/gemini";
import type { SealedHostedMediaReceipt } from "../apps/workflows/src/contracts";
import {
  GeminiHostedAnalysisProvider,
} from "../apps/workflows/src/provider";
import { listBuiltInRecipes } from "../src/recipes";
import { hostedSpendEstimator } from "../apps/workflows/src/spend";
import { createE2EEnvironment } from "./e2e-environment";
import { createE2EIsolation } from "../apps/web/e2e/support/isolation";
import {
  betterAuthBrowserLogins,
  betterAuthFixtureVars,
  hostedAuthHeaders,
  hostedContractAuthMode,
  startFakeGithub,
} from "./hosted-auth-fixture";
import {
  resolvePrebuiltWebOutput,
  resolvePrebuiltWorkflowsOutput,
} from "./prebuilt-artifact";

const isolation = await createE2EIsolation("hosted-workflows");
const temporaryRoot = isolation.root;
const persistRoot = isolation.persistRoot;
const webConfigPath = join(temporaryRoot, "web.wrangler.jsonc");
const disabledWebConfigPath = join(temporaryRoot, "web-disabled.wrangler.jsonc");
const workflowConfigPath = join(temporaryRoot, "workflow.wrangler.jsonc");
const seedPath = join(temporaryRoot, "seed.sql");
const workflowOutdir = join(temporaryRoot, "workflow-bundle");
const databaseName = isolation.databaseName;
const databaseId = isolation.databaseId;
const workflowServiceName = isolation.workerName("hosted-workflow");
const prebuiltOutput = await resolvePrebuiltWebOutput("cloudflare_module");
const prebuiltWorkflows = await resolvePrebuiltWorkflowsOutput();
const webArtifact = prebuiltOutput ?? resolve("apps/web/.output");
const workflowMain = prebuiltWorkflows
  ? join(prebuiltWorkflows, "index.js")
  : resolve("apps/workflows/src/index.ts");
const audience = "frame-of-mind-hosted-workflow-contract";
const keyId = "hosted-workflow-contract-key";
let principalA = "hosted-workflow-principal-a";
let principalB = "hosted-workflow-principal-b";
let principalRace = "hosted-workflow-principal-race";
let principalOverrun = "hosted-workflow-principal-overrun";
let principalJanitor = "hosted-workflow-principal-janitor";
const normalMedia = "media_hosted_normal_0001";
const crashMedia = "media_hosted_crash_0001";
const cancelMedia = "media_hosted_cancel_0001";
const overrunMedia = "media_hosted_overrun_0001";
const janitorMedia = "media_hosted_janitor_0001";
const missingHashMedia = "media_hosted_missing_hash_0001";
const legacyDisplayMedia = "media_hosted_legacy_display_0001";
const legacyDisplayJob = "job_hosted_legacy_display_0001";
const legacyDisplayAttempt = "attempt_hosted_legacy_display_0001";
const foreignDisplayJob = "job_hosted_foreign_display_0001";
const foreignDisplayAttempt = "attempt_hosted_foreign_display_0001";
const janitorAttempt = "attempt_hosted_janitor_0001";
const recipeStartMedia = listBuiltInRecipes().map((recipe, index) => ({
  recipeId: recipe.id,
  mediaId: `media_recipe_start_${String(index + 1).padStart(2, "0")}`,
}));
const mediaSha256 = "a".repeat(64);
const contractSpendPlan = hostedSpendEstimator.estimate(1, {
  videoTokensPerSecond: 300,
  promptOutputHeadroomPerCall: 100,
  maxInterrogationCalls: 1,
  principalCapUnits: Number.MAX_SAFE_INTEGER,
});
const principalACapUnits = contractSpendPlan.estimatedTokens + 1_999;
const raceCapUnits = contractSpendPlan.estimatedTokens * 3;
const wranglerBin = resolve("apps/web/node_modules/wrangler/bin/wrangler.js");
let webWorker: ReturnType<typeof Bun.spawn> | undefined;
let workflowWorker: ReturnType<typeof Bun.spawn> | undefined;
let disabledWebWorker: ReturnType<typeof Bun.spawn> | undefined;
let jwksServer: ReturnType<typeof Bun.serve> | undefined;
let fakeGithub: ReturnType<typeof startFakeGithub> | undefined;
let webOutput: Promise<[string, string]> | undefined;
let workflowOutput: Promise<[string, string]> | undefined;
let disabledWebOutput: Promise<[string, string]> | undefined;
let dispatchRetryTail = Promise.resolve();

try {
  console.log("HOSTED_WORKFLOW build=START nuxt_and_workflow");
  if (prebuiltOutput) {
    console.log("HOSTED_WORKFLOW build=SKIP prebuilt=cloudflare_module");
  } else {
    await runChecked(
      ["bun", "--no-env-file", "run", "--cwd", "apps/web", "build:cloudflare"],
      "hosted Nuxt Worker build",
      {
        FRAME_OF_MIND_STUDIO: "1",
        FRAME_OF_MIND_HOSTED_WORKFLOWS: "1",
      },
    );
  }
  const nitroBundle = await readFile(
    join(webArtifact, "server/chunks/nitro/nitro.mjs"),
    "utf8",
  );
  const hostedBundleText = [nitroBundle];
  for await (const path of new Bun.Glob("**/*.mjs").scan({
    cwd: join(webArtifact, "server"),
    absolute: true,
  })) {
    hostedBundleText.push(await readFile(path, "utf8"));
  }
  const hostedBundle = hostedBundleText.join("\n");
  for (const marker of [
    "/api/hosted/jobs",
    "/api/hosted/composer/jobs",
    "/api/hosted/spend/janitor",
    "/hosted/activity",
    "/review/:runId",
    "/api/hosted/jobs/:id/support-receipt",
    "data-hosted-studio-shell",
    "data-studio-review",
    "Hosted Workflow bindings are unavailable",
    "hosted-video-v2",
    "spend_reservation_created",
    "hosted-workflows.internal/telemetry",
  ]) {
    if (!hostedBundle.includes(marker)) {
      throw new Error(`Hosted Nuxt build omitted ${marker}.`);
    }
  }

  const keys = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(keys.publicKey);
  jwksServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname !== "/cdn-cgi/access/certs") {
        return new Response("not found", { status: 404 });
      }
      return Response.json({
        keys: [{ ...publicJwk, kid: keyId, alg: "RS256", use: "sig" }],
      });
    },
  });
  const issuer = `http://127.0.0.1:${jwksServer.port}`;
  const workerPort = await isolation.reservePort();
  const baseUrl = `http://127.0.0.1:${workerPort}`;
  const disabledPort = await isolation.reservePort();
  const disabledOrigin = `http://127.0.0.1:${disabledPort}`;
  fakeGithub = hostedContractAuthMode === "better-auth"
    ? startFakeGithub([
        { id: "workflow-a", email: "workflow-a@example.test" },
        { id: "workflow-b", email: "workflow-b@example.test" },
        { id: "workflow-race", email: "workflow-race@example.test" },
        { id: "workflow-overrun", email: "workflow-overrun@example.test" },
        { id: "workflow-janitor", email: "workflow-janitor@example.test" },
      ])
    : undefined;
  const authVars = hostedContractAuthMode === "better-auth"
    ? betterAuthFixtureVars(baseUrl, fakeGithub!.origin)
    : {
        NUXT_AUTH_MODE: "cloudflare-access",
        NUXT_CLOUDFLARE_ACCESS_TEAM_DOMAIN: issuer,
        NUXT_CLOUDFLARE_ACCESS_AUD: audience,
        NUXT_CLOUDFLARE_ACCESS_ALLOW_INSECURE_TEST_JWKS: "true",
      };
  await writeFile(webConfigPath, JSON.stringify({
    $schema: resolve("apps/web/node_modules/wrangler/config-schema.json"),
    name: isolation.workerName("hosted-web"),
    main: join(webArtifact, "server/index.mjs"),
    compatibility_date: "2026-08-18",
    compatibility_flags: ["nodejs_compat", "nodejs_als"],
    assets: {
      directory: join(webArtifact, "public"),
      binding: "ASSETS",
    },
    d1_databases: [d1Binding()],
    services: [{
      binding: "HOSTED_WORKFLOWS",
      service: workflowServiceName,
    }],
    vars: {
      ...authVars,
      NUXT_HOSTED_WORKFLOWS_ENABLED: "true",
      NUXT_HOSTED_SPEND_PRINCIPAL_CAP_UNITS: String(principalACapUnits),
      NUXT_HOSTED_SPEND_VIDEO_TOKENS_PER_SECOND: "300",
      NUXT_HOSTED_SPEND_PROMPT_OUTPUT_HEADROOM_PER_CALL: "100",
      NUXT_HOSTED_SPEND_MAX_INTERROGATION_CALLS: "1",
    },
  }, null, 2));
  await writeFile(disabledWebConfigPath, JSON.stringify({
    $schema: resolve("apps/web/node_modules/wrangler/config-schema.json"),
    name: isolation.workerName("hosted-web-disabled"),
    main: join(webArtifact, "server/index.mjs"),
    compatibility_date: "2026-08-18",
    compatibility_flags: ["nodejs_compat", "nodejs_als"],
    assets: { directory: join(webArtifact, "public"), binding: "ASSETS" },
    d1_databases: [d1Binding()],
    services: [{
      binding: "HOSTED_WORKFLOWS",
      service: workflowServiceName,
    }],
    vars: {
      ...(hostedContractAuthMode === "better-auth"
        ? betterAuthFixtureVars(disabledOrigin, fakeGithub!.origin)
        : authVars),
      NUXT_HOSTED_WORKFLOWS_ENABLED: "false",
      NUXT_HOSTED_WORKFLOW_RESERVATION_UNITS: "1",
    },
  }, null, 2));
  await writeFile(workflowConfigPath, JSON.stringify({
    $schema: resolve("apps/web/node_modules/wrangler/config-schema.json"),
    name: workflowServiceName,
    main: workflowMain,
    compatibility_date: "2026-08-18",
    compatibility_flags: ["nodejs_compat"],
    d1_databases: [d1Binding()],
    workflows: [{
      name: isolation.workerName("hosted-analysis"),
      binding: "HOSTED_WORKFLOW",
      class_name: "HostedAnalysisWorkflow",
    }],
    vars: {
      HOSTED_FAKE_GEMINI: "true",
      HOSTED_FAKE_START_DELAY_MEDIA_ID: cancelMedia,
      HOSTED_FAKE_RECEIPT_FAILURE_MEDIA_ID: crashMedia,
      HOSTED_FAKE_RECEIPT_FAILURE_STEP: "transcribe",
      HOSTED_FAKE_USAGE_OVERRUN_MEDIA_ID: overrunMedia,
      HOSTED_FAKE_STAGE_DELAY_MS: "3000",
      HOSTED_FAKE_STAGE_DELAY_MEDIA_ID: normalMedia,
      HOSTED_FAKE_FILE_MISSING_HASH_MEDIA_ID: missingHashMedia,
    },
  }, null, 2));
  if (prebuiltWorkflows) {
    console.log("HOSTED_WORKFLOW workflow_build=SKIP prebuilt=cloudflare-workflows");
  } else {
    await runChecked([
      "node", wranglerBin, "deploy", "--dry-run", "--config", workflowConfigPath,
      "--outdir", workflowOutdir,
    ], "Workflow Worker dry run");
  }
  console.log("HOSTED_WORKFLOW build=PASS nuxt_and_workflow");
  await verifyRealAdapterContract();

  const migrationArgs = [
    "node", wranglerBin, "d1", "migrations", "apply", databaseName,
    "--local", "--config", webConfigPath, "--persist-to", persistRoot,
  ];
  await runChecked(migrationArgs, "hosted Workflow D1 migrations");
  if (hostedContractAuthMode === "better-auth") {
    await runChecked([
      "node", wranglerBin, "d1", "execute", databaseName,
      "--local", "--config", webConfigPath, "--persist-to", persistRoot,
      "--command", "INSERT INTO hosted_auth_invites (email, invited_at) VALUES "
        + "('workflow-a@example.test','2026-08-23T00:00:00.000Z'),"
        + "('workflow-b@example.test','2026-08-23T00:00:00.000Z'),"
        + "('workflow-race@example.test','2026-08-23T00:00:00.000Z'),"
        + "('workflow-overrun@example.test','2026-08-23T00:00:00.000Z'),"
        + "('workflow-janitor@example.test','2026-08-23T00:00:00.000Z')",
    ], "hosted Workflow Better Auth invites");
  } else {
    await writeSeed();
  }

  const workflowPort = await isolation.reservePort();
  workflowWorker = Bun.spawn([
    "node", wranglerBin, "dev", "--local",
    "--config", workflowConfigPath,
    "--persist-to", persistRoot,
    "--ip", "127.0.0.1",
    "--port", String(workflowPort),
    "--inspector-port", "0",
    "--log-level", "error",
    "--show-interactive-dev-session=false",
  ], {
    cwd: process.cwd(),
    env: createE2EEnvironment(process.env),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  workflowOutput = Promise.all([
    new Response(workflowWorker.stdout).text(),
    new Response(workflowWorker.stderr).text(),
  ]);
  await waitForWorker(
    `http://127.0.0.1:${workflowPort}/health`,
    workflowWorker,
    200,
  );
  await expectStatus(fetch(`http://127.0.0.1:${workflowPort}/telemetry`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      area: "upload",
      outcome: "started",
      code: "hosted_upload_started",
      routeClass: "hosted_upload",
      byteCount: 0,
      studioMode: "hosted",
    }),
  }), 202, "codes-only telemetry event");
  await expectStatus(fetch(`http://127.0.0.1:${workflowPort}/telemetry`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      area: "upload",
      outcome: "failed",
      code: "hosted_upload_failed",
      email: "seat@example.test",
      studioMode: "hosted",
    }),
  }), 400, "telemetry content rejection");
  console.log(
    "HOSTED_TELEMETRY contract=PASS codes_and_structural_fields_only dsn_default=off upload=interface_only",
  );

  webWorker = Bun.spawn([
    "node", wranglerBin, "dev", "--local",
    "--config", webConfigPath,
    "--persist-to", persistRoot,
    "--ip", "127.0.0.1",
    "--port", String(workerPort),
    "--inspector-port", "0",
    "--log-level", "error",
    "--show-interactive-dev-session=false",
  ], {
    cwd: process.cwd(),
    env: createE2EEnvironment(process.env),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  webOutput = Promise.all([
    new Response(webWorker.stdout).text(),
    new Response(webWorker.stderr).text(),
  ]);
  await waitForWorker(`${baseUrl}/api/health`, webWorker, 403);

  const betterAuthCredentials = hostedContractAuthMode === "better-auth"
    ? await betterAuthBrowserLogins(baseUrl, [
        "workflow-a@example.test",
        "workflow-b@example.test",
        "workflow-race@example.test",
        "workflow-overrun@example.test",
        "workflow-janitor@example.test",
      ])
    : undefined;
  const tokenA = hostedContractAuthMode === "better-auth"
    ? betterAuthCredentials!.get("workflow-a@example.test")!
    : await signAccessToken(keys.privateKey, issuer, principalA);
  const tokenB = hostedContractAuthMode === "better-auth"
    ? betterAuthCredentials!.get("workflow-b@example.test")!
    : await signAccessToken(keys.privateKey, issuer, principalB);
  const tokenRace = hostedContractAuthMode === "better-auth"
    ? betterAuthCredentials!.get("workflow-race@example.test")!
    : await signAccessToken(keys.privateKey, issuer, principalRace);
  const tokenOverrun = hostedContractAuthMode === "better-auth"
    ? betterAuthCredentials!.get("workflow-overrun@example.test")!
    : await signAccessToken(keys.privateKey, issuer, principalOverrun);
  const tokenJanitor = hostedContractAuthMode === "better-auth"
    ? betterAuthCredentials!.get("workflow-janitor@example.test")!
    : await signAccessToken(keys.privateKey, issuer, principalJanitor);
  if (hostedContractAuthMode === "better-auth") {
    principalA = await betterAuthPrincipal("workflow-a@example.test");
    principalB = await betterAuthPrincipal("workflow-b@example.test");
    principalRace = await betterAuthPrincipal("workflow-race@example.test");
    principalOverrun = await betterAuthPrincipal("workflow-overrun@example.test");
    principalJanitor = await betterAuthPrincipal("workflow-janitor@example.test");
    await stopContractWorker(webWorker, webOutput);
    webWorker = undefined;
    webOutput = undefined;
    await stopContractWorker(workflowWorker, workflowOutput);
    workflowWorker = undefined;
    workflowOutput = undefined;
    await writeSeed();
    const restartedWorkflow = await startContractWorker({
      configPath: workflowConfigPath,
      persistRoot,
      port: workflowPort,
      readinessUrl: `http://127.0.0.1:${workflowPort}/health`,
      readinessStatus: 200,
    });
    workflowWorker = restartedWorkflow.worker;
    workflowOutput = restartedWorkflow.output;
    const restartedWeb = await startContractWorker({
      configPath: webConfigPath,
      persistRoot,
      port: workerPort,
      readinessUrl: `${baseUrl}/api/health`,
      readinessStatus: 403,
    });
    webWorker = restartedWeb.worker;
    webOutput = restartedWeb.output;
  }
  disabledWebWorker = Bun.spawn([
    "node", wranglerBin, "dev", "--local",
    "--config", disabledWebConfigPath,
    "--persist-to", persistRoot,
    "--ip", "127.0.0.1",
    "--port", String(disabledPort),
    "--inspector-port", "0",
    "--log-level", "error",
    "--show-interactive-dev-session=false",
  ], {
    cwd: process.cwd(),
    env: createE2EEnvironment(process.env),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  disabledWebOutput = Promise.all([
    new Response(disabledWebWorker.stdout).text(),
    new Response(disabledWebWorker.stderr).text(),
  ]);
  await waitForWorker(`${disabledOrigin}/api/health`, disabledWebWorker, 403);
  for (const path of [
    "/api/hosted/configuration",
    "/api/hosted/jobs",
    "/hosted/new/intent",
    "/hosted/new/context",
    "/hosted/new/recording",
    "/hosted/new/run",
    "/hosted/activity",
    "/hosted/activity/attempt_dark_0001",
    "/review/hosted_attempt_dark_0001",
    "/api/hosted/jobs/attempt_dark_0001/support-receipt",
  ]) {
    await expectStatus(authenticatedFetch(disabledOrigin, path, tokenA), 404, `disabled ${path}`);
  }
  for (const path of [
    "/api/hosted/jobs",
    "/api/hosted/composer/jobs",
    "/api/hosted/spend/janitor",
  ]) {
    await expectStatus(fetch(`${disabledOrigin}${path}`, {
      method: "POST",
      headers: mutationHeaders(disabledOrigin, tokenA),
      body: "{}",
    }), 404, `disabled mutation ${path}`);
  }
  disabledWebWorker.kill("SIGTERM");
  await disabledWebWorker.exited;
  await disabledWebOutput;
  disabledWebWorker = undefined;
  disabledWebOutput = undefined;
  console.log("HOSTED_WORKFLOW dark=PASS runtime_disabled_routes_404");

  const janitorResponse = await json<{
    ok: boolean;
    released: number;
    committed: number;
  }>(await expectStatus(fetch(`${baseUrl}/api/hosted/spend/janitor`, {
    method: "POST",
    headers: mutationHeaders(baseUrl, tokenJanitor),
    body: "{}",
    signal: AbortSignal.timeout(30_000),
  }), 200, "expired reservation janitor"));
  assertEqual(janitorResponse, { ok: true, released: 1, committed: 0 }, "janitor result");
  const janitorReplay = await json<{
    ok: boolean;
    released: number;
    committed: number;
  }>(await expectStatus(fetch(`${baseUrl}/api/hosted/spend/janitor`, {
    method: "POST",
    headers: mutationHeaders(baseUrl, tokenJanitor),
    body: "{}",
    signal: AbortSignal.timeout(30_000),
  }), 200, "idempotent expired reservation janitor"));
  assertEqual(janitorReplay, { ok: true, released: 0, committed: 0 }, "janitor replay");
  assertEqual(
    (await queryReservation(principalJanitor, janitorAttempt)).state,
    "released",
    "janitor released state",
  );

  const normal = await createJob(baseUrl, tokenA, normalMedia, "normal-submit-key");
  const normalTerminal = await waitForTerminal(baseUrl, tokenA, normal.job.id);
  assertEqual(normalTerminal.job.stage, "succeeded", "normal terminal stage");
  assertEqual(normalTerminal.job.cleanupCompleted, true, "normal cleanup");
  if (!normalTerminal.job.runId) throw new Error("Published attempt omitted runId.");
  const published = await json<StoredRunView>(await expectStatus(
    authenticatedFetch(baseUrl, `/api/runs/${normalTerminal.job.runId}`, tokenA),
    200,
    "principal published run",
  ));
  await validateVersionedRunImport({
    analysis: published.analysis,
    manifest: published.manifest,
  });
  assertEqual(published.runId, normalTerminal.job.runId, "published viewer run ID");
  const supportReceipt = await (await expectStatus(
    authenticatedFetch(baseUrl, `/api/hosted/jobs/${normal.job.id}/support-receipt`, tokenA),
    200,
    "principal support receipt",
  )).text();
  if (!supportReceipt.startsWith("Frame of Mind support receipt v1\n")) {
    throw new Error("Hosted support receipt did not use the closed support format.");
  }
  const reviewHtml = await (await expectStatus(
    authenticatedFetch(baseUrl, `/review/${normalTerminal.job.runId}`, tokenA),
    200,
    "principal hosted review workspace",
  )).text();
  if (!reviewHtml.includes("data-studio-review=\"hosted\"")) {
    throw new Error("Hosted review workspace did not render its principal-scoped module.");
  }

  const overrun = await createJob(
    baseUrl,
    tokenOverrun,
    overrunMedia,
    "overrun-submit-key",
  );
  const overrunTerminal = await waitForTerminal(
    baseUrl,
    tokenOverrun,
    overrun.job.id,
  );
  assertEqual(overrunTerminal.job.stage, "indeterminate", "overrun terminal stage");
  assertEqual(
    overrunTerminal.job.errorCode,
    "spend_actual_exceeds_reservation",
    "overrun terminal code",
  );
  assertEqual(overrunTerminal.job.runId, undefined, "overrun publication blocked");
  const overrunReservation = await queryReservation(
    principalOverrun,
    overrun.job.id,
  );
  assertEqual(
    await queryCommittedUnits(principalOverrun),
    contractSpendPlan.estimatedTokens,
    "overrun committed ceiling",
  );
  if (overrunReservation.actual_units <= overrunReservation.reserved_units) {
    throw new Error("Overrun fixture did not exceed the reservation.");
  }
  console.log("HOSTED_SPEND overrun=PASS actual_gt_reserved=failed_closed");

  const listA = await json<{ jobs: JobView[] }>(await expectStatus(
    authenticatedFetch(baseUrl, "/api/hosted/jobs", tokenA),
    200,
    "principal activity list",
  ));
  if (!listA.jobs.some((job) => job.id === normal.job.id)) {
    throw new Error("Principal activity list omitted the published attempt.");
  }
  const normalListJob = listA.jobs.find((job) => job.id === normal.job.id);
  const legacyListJob = listA.jobs.find((job) => job.id === legacyDisplayAttempt);
  if (!normalListJob?.receipt.recording) {
    throw new Error("Principal activity list omitted valid recording details.");
  }
  if (!legacyListJob) {
    throw new Error("Principal activity list omitted the legacy attempt.");
  }
  assertEqual(
    legacyListJob.receipt.recording,
    undefined,
    "legacy display receipt omitted only unavailable recording details",
  );
  console.log("HOSTED_WORKFLOW legacy_display=PASS list_200 valid_and_null_size_rows=true");
  const legacyDetail = await json<JobDetail>(await expectStatus(
    authenticatedFetch(baseUrl, `/api/hosted/jobs/${legacyDisplayAttempt}`, tokenA),
    200,
    "legacy activity detail",
  ));
  assertEqual(legacyDetail.job.id, legacyDisplayAttempt, "legacy activity detail attempt");
  assertEqual(
    legacyDetail.job.receipt.recording,
    undefined,
    "legacy activity detail omits unavailable recording details",
  );
  if ("media" in legacyDetail) {
    throw new Error("Legacy activity detail exposed an invalid media block.");
  }
  const listB = await json<{ jobs: JobView[] }>(await expectStatus(
    authenticatedFetch(baseUrl, "/api/hosted/jobs", tokenB),
    200,
    "foreign activity list",
  ));
  assertEqual(listB.jobs.length, 1, "foreign activity list fixture count");
  assertEqual(listB.jobs[0]?.id, foreignDisplayAttempt, "foreign activity list attempt");
  assertEqual(
    listB.jobs[0]?.receipt.recording,
    undefined,
    "foreign activity list omits another principal's recording details",
  );
  const hostedCatalog = await json<{
    recipes: Array<{ id: string; revision: string }>;
  }>(await expectStatus(
    authenticatedFetch(baseUrl, "/api/hosted/recipes", tokenB),
    200,
    "hosted built-in recipe catalog",
  ));
  assertEqual(
    hostedCatalog.recipes.map((recipe) => recipe.id),
    listBuiltInRecipes().map((recipe) => recipe.id),
    "hosted built-in recipe IDs",
  );
  const missingRecipe = await json<{ data: { code: string } }>(await expectStatus(
    composerJobResponse(
      baseUrl,
      tokenB,
      recipeStartMedia[0]!.mediaId,
      "missing-recipe-start",
      "removed-recipe",
      "removed-revision",
    ),
    422,
    "removed hosted recipe",
  ));
  assertEqual(missingRecipe.data.code, "recipe_not_found", "removed recipe error code");
  for (const fixture of recipeStartMedia) {
    const catalogRecipe = hostedCatalog.recipes.find(
      (recipe) => recipe.id === fixture.recipeId,
    );
    if (!catalogRecipe) {
      throw new Error(`Hosted catalog omitted built-in recipe ${fixture.recipeId}.`);
    }
    const started = await json<JobResponse>(await expectStatus(composerJobResponse(
      baseUrl,
      tokenB,
      fixture.mediaId,
      `recipe-start-${fixture.recipeId}`,
      fixture.recipeId,
      catalogRecipe.revision,
    ), 201, `start built-in recipe ${fixture.recipeId}`));
    const terminal = await waitForTerminal(baseUrl, tokenB, started.job.id);
    assertEqual(terminal.job.stage, "succeeded", `complete built-in recipe ${fixture.recipeId}`);
  }
  console.log("HOSTED_WORKFLOW recipes=PASS every_built_in_started_from_catalog_receipt");
  await expectStatus(
    authenticatedFetch(baseUrl, `/api/hosted/jobs/${normal.job.id}`, tokenB),
    404,
    "cross-principal hosted detail",
  );
  await expectStatus(
    authenticatedFetch(baseUrl, `/api/hosted/jobs/${normal.job.rootJobId}`, tokenB),
    404,
    "cross-principal guessed root job",
  );
  await expectStatus(
    authenticatedFetch(baseUrl, `/api/hosted/media/${normalMedia}`, tokenB),
    404,
    "cross-principal hosted media",
  );
  await expectStatus(
    authenticatedFetch(baseUrl, `/api/runs/${normalTerminal.job.runId}`, tokenB),
    404,
    "cross-principal published run",
  );
  await expectStatus(
    authenticatedFetch(baseUrl, `/review/${normalTerminal.job.runId}`, tokenB),
    404,
    "cross-principal hosted review workspace",
  );
  await expectStatus(
    authenticatedFetch(baseUrl, `/api/hosted/jobs/${normal.job.id}/support-receipt`, tokenB),
    404,
    "cross-principal support receipt",
  );
  await createJob(baseUrl, tokenB, normalMedia, "foreign-media-create", 404);
  await expectStatus(fetch(`${baseUrl}/api/hosted/composer/jobs`, {
    method: "POST",
    headers: mutationHeaders(baseUrl, tokenB),
    body: JSON.stringify({
      idempotencyKey: "foreign-media-composer",
      mediaSessionId: normalMedia,
      context: { mode: "none" },
      recipe: { id: "decisions", revision: "builtin-2026-08-11.1" },
      model: "gemini-3.7-flash",
      retention: { mode: "ephemeral" },
    }),
  }), 404, "cross-principal composer create with foreign media");
  console.log("HOSTED_WORKFLOW principal_isolation=PASS activity_media_run_foreign_ids=404 create_with_foreign_media=404");

  const missingHash = await createJob(
    baseUrl,
    tokenB,
    missingHashMedia,
    "missing-hash-submit-key",
  );
  const missingHashTerminal = await waitForTerminal(
    baseUrl,
    tokenB,
    missingHash.job.id,
  );
  assertEqual(missingHashTerminal.job.stage, "failed", "missing hash terminal stage");
  assertEqual(
    missingHashTerminal.job.errorCode,
    "media_seal_mismatch",
    "missing hash sanitized terminal code",
  );
  assertEqual(missingHashTerminal.job.runId, undefined, "missing hash publication blocked");
  console.log("HOSTED_WORKFLOW missing_provider_hash=PASS failed_closed=media_seal_mismatch");

  const canceled = await createJob(baseUrl, tokenA, cancelMedia, "cancel-submit-key");
  await expectStatus(fetch(`${baseUrl}/api/hosted/jobs/${canceled.job.id}/cancel`, {
    method: "POST",
    headers: mutationHeaders(baseUrl, tokenA),
    body: "{}",
  }), 200, "cancel hosted attempt");
  const canceledTerminal = await waitForTerminal(baseUrl, tokenA, canceled.job.id);
  assertEqual(canceledTerminal.job.stage, "canceled", "canceled terminal stage");
  assertEqual(
    (await queryReservation(principalA, canceled.job.id)).state,
    "released",
    "zero-claim cancellation reservation",
  );
  console.log(
    "HOSTED_SPEND release=PASS cancel_zero_claims=released janitor=released_expired",
  );
  const canceledRetry = await json<JobResponse>(await expectOneOf(
    retryJob(baseUrl, tokenA, canceled.job.id, "cancel-retry-key"),
    [200, 201],
    "retry canceled attempt",
  ));
  const canceledRetryTerminal = await waitForTerminal(
    baseUrl,
    tokenA,
    canceledRetry.job.id,
  );
  assertEqual(canceledRetryTerminal.job.stage, "succeeded", "canceled retry stage");
  console.log("HOSTED_WORKFLOW cancel_retry=PASS canceled_then_linked_success");

  await verifyHostedBrowserContract(baseUrl, tokenA, normalMedia);

  const crashed = await createJob(baseUrl, tokenA, crashMedia, "crash-submit-key");
  const crashTerminal = await waitForTerminal(baseUrl, tokenA, crashed.job.id);
  assertEqual(crashTerminal.job.stage, "indeterminate", "crash terminal stage");
  assertEqual(crashTerminal.job.cleanupCompleted, true, "crash cleanup");
  assertEqual(
    crashTerminal.events.filter((event) => event.code === "gemini_transcribe_started").length,
    1,
    "provider invocation count after receipt crash",
  );
  const workflowInstanceId = await queryWorkflowInstanceId(
    crashed.job.id,
  );
  await runChecked([
    "node", wranglerBin, "workflows", "instances", "restart",
    isolation.workerName("hosted-analysis"), workflowInstanceId,
    "--local", "--port", String(workflowPort),
    "--config", workflowConfigPath,
    "--from-step-name", "transcribe",
    "--from-step-type", "do",
  ], "restart crashed Workflow from provider step");
  const afterReplay = await waitForEvent(
    baseUrl,
    tokenA,
    crashed.job.id,
    "provider_claim_without_receipt",
  );
  assertEqual(
    afterReplay.events.filter((event) => event.code === "gemini_transcribe_started").length,
    1,
    "no second provider invocation after replay",
  );
  assertEqual(afterReplay.job.stage, "indeterminate", "replayed crash stage");
  assertEqual(afterReplay.job.cleanupCompleted, true, "replayed crash cleanup");
  console.log(
    "HOSTED_WORKFLOW crash_after_provider=PASS provider_calls=1 indeterminate=true cleanup=true",
  );

  const [retryOneResponse, retryTwoResponse] = await Promise.all([
    retryJob(baseUrl, tokenA, crashed.job.id, "retry-submit-key"),
    retryJob(baseUrl, tokenA, crashed.job.id, "retry-submit-key"),
  ]);
  const retryOne = await json<JobResponse>(
    await expectOneOf(retryOneResponse, [200, 201], "first retry submit"),
  );
  const retryTwo = await json<JobResponse>(
    await expectOneOf(retryTwoResponse, [200, 201], "second retry submit"),
  );
  assertEqual(retryOne.job.id, retryTwo.job.id, "retry double-submit identity");
  if (retryOne.job.id === crashed.job.id) {
    throw new Error("Retry reused the prior attempt ID.");
  }
  if ("workflowInstanceId" in retryOne.job || "workflowInstanceId" in retryTwo.job) {
    throw new Error("Hosted route exposed an internal Workflow instance ID.");
  }
  const retryTerminal = await waitForTerminal(baseUrl, tokenA, retryOne.job.id);
  assertEqual(retryTerminal.job.stage, "indeterminate", "retry terminal stage");
  const parentAfterRetry = await getJob(baseUrl, tokenA, crashed.job.id);
  assertEqual(parentAfterRetry.job.stage, "indeterminate", "prior attempt immutable");
  console.log("HOSTED_WORKFLOW retry=PASS linked_new_attempt double_submit_deduped");
  const capped = await createJobResponse(
    baseUrl,
    tokenA,
    normalMedia,
    "cap-exhausted-submit-key",
  );
  await expectStatus(capped, 429, "spend-capped create");
  const cappedBody = await json<{ data?: { code?: string } }>(capped);
  assertEqual(
    cappedBody.data?.code,
    "principal_spend_cap_exceeded",
    "spend-capped code",
  );
  assertEqual(
    await queryCount(
      "hosted_analysis_attempts",
      "idempotency_key = 'cap-exhausted-submit-key'",
    ),
    0,
    "no attempt or Workflow receipt after cap exhaustion",
  );
  const cappedComposer = await composerJobResponse(
    baseUrl,
    tokenA,
    normalMedia,
    "composer-cap-exhausted-submit-key",
  );
  await expectStatus(cappedComposer, 429, "spend-capped composer create");
  const cappedComposerBody = await json<{ data?: { code?: string } }>(
    cappedComposer,
  );
  assertEqual(
    cappedComposerBody.data?.code,
    "principal_spend_cap_exceeded",
    "spend-capped composer code",
  );
  assertEqual(
    await queryCount(
      "hosted_analysis_attempts",
      "idempotency_key = 'composer-cap-exhausted-submit-key'",
    ),
    0,
    "no composer attempt or Workflow receipt after cap exhaustion",
  );
  assertEqual(
    await queryCommittedUnits(principalA),
    2000,
    "provider-usage spend reconciliation",
  );
  console.log(
    "HOSTED_SPEND reserve=PASS race=unit_contract reconcile=provider_usage create_cap=429 composer_cap=429 workflow_created=false",
  );
  // Keep the intentionally concurrent admission burst last. Its contract is
  // the atomic HTTP admission result; successful Workflow completion is
  // already covered above. Stop the fake Workflow Worker after the receipts
  // so Linux workerd's SQLite-backed D1 scheduling cannot alter that oracle.
  const raceSize = 10;
  const raceResponses = await Promise.all(
    Array.from({ length: raceSize }, (_, index) => createJobResponse(
      baseUrl,
      tokenRace,
      cancelMedia,
      `http-race-${String(index + 1).padStart(2, "0")}`,
    )),
  );
  const raceCodes = await Promise.all(raceResponses.map(async (response) => {
    const body = await response.clone().json().catch(() => undefined) as
      | { data?: { code?: string } }
      | undefined;
    return body?.data?.code ?? `http_${response.status}`;
  }));
  const admitted = raceResponses.filter((response, index) =>
    [200, 201].includes(response.status)
    || (response.status === 503 && raceCodes[index] === "hosted_workflow_dispatch_failed")
  );
  const rejected = raceResponses.filter((response) => response.status === 429);
  console.log(
    `HOSTED_SPEND race_statuses=${raceResponses.map((response) => response.status).join(",")}`,
  );
  console.log(`HOSTED_SPEND race_codes=${raceCodes.join(",")}`);
  if (admitted.length !== 3 || rejected.length !== raceSize - 3) {
    const responseReceipts = await Promise.all(raceResponses.map(async (response, index) => ({
      request: index + 1,
      status: response.status,
      body: await response.clone().text(),
    })));
    const databaseReceipt = await queryRaceFailureReceipt();
    console.error(`HOSTED_SPEND race_failure=${JSON.stringify({
      responses: responseReceipts,
      database: databaseReceipt,
    })}`);
  }
  assertEqual(admitted.length, 3, "HTTP concurrent spend admissions");
  assertEqual(rejected.length, raceSize - 3, "HTTP concurrent spend rejections");
  for (const response of rejected) {
    const body = await json<{ data?: { code?: string } }>(response);
    assertEqual(body.data?.code, "principal_spend_cap_exceeded", "HTTP race cap code");
  }
  await stopContractWorker(workflowWorker, workflowOutput);
  workflowWorker = undefined;
  workflowOutput = undefined;
  assertEqual(
    await queryCount(
      "hosted_analysis_attempts",
      `principal_sub = '${principalRace}' AND idempotency_key LIKE 'http-race-%'`,
    ),
    3,
    "HTTP race created durable attempts",
  );
  console.log(
    `HOSTED_SPEND race=http_concurrent admitted=3 rejected=${raceSize - 3}`,
  );
  console.log("HOSTED_SPEND_CONTRACT PASSED");
  console.log("HOSTED_STUDIO_CONTRACT PASSED");
  console.log("HOSTED_WORKFLOW_CONTRACT PASSED");

  await stopContractWorker(webWorker, webOutput);
  webWorker = undefined;
  webOutput = undefined;
} catch (error) {
  if (webWorker) {
    webWorker.kill("SIGTERM");
    await webWorker.exited;
  }
  if (workflowWorker) {
    workflowWorker.kill("SIGTERM");
    await workflowWorker.exited;
  }
  if (disabledWebWorker) {
    disabledWebWorker.kill("SIGTERM");
    await disabledWebWorker.exited;
  }
  if (webOutput) {
    const [stdout, stderr] = await webOutput;
    process.stderr.write(`Hosted web workerd output:\n${stdout}\n${stderr}`.slice(0, 10_000));
  }
  if (workflowOutput) {
    const [stdout, stderr] = await workflowOutput;
    process.stderr.write(`Hosted Workflow workerd output:\n${stdout}\n${stderr}`.slice(0, 10_000));
  }
  if (disabledWebOutput) {
    const [stdout, stderr] = await disabledWebOutput;
    process.stderr.write(`Disabled hosted web workerd output:\n${stdout}\n${stderr}`.slice(0, 10_000));
  }
  throw error;
  } finally {
  jwksServer?.stop(true);
  fakeGithub?.stop();
  if (process.env.KEEP_HOSTED_WORKFLOW_TEMP === "1") {
    console.error(`Hosted Workflow temp retained at ${temporaryRoot}`);
  } else {
    await isolation.cleanup();
  }
}

interface JobView {
  id: string;
  rootJobId: string;
  stage: string;
  cleanupCompleted: boolean;
  runId?: string;
  errorCode?: string;
  receipt: {
    recording?: { durationSeconds: number; sizeBytes: number };
  };
}

interface JobResponse {
  job: JobView;
}

interface JobDetail extends JobResponse {
  media?: unknown;
  events: Array<{ code?: string }>;
}

interface StoredRunView {
  runId: string;
  analysis: Parameters<typeof validateVersionedRunImport>[0]["analysis"];
  manifest: Parameters<typeof validateVersionedRunImport>[0]["manifest"];
}

async function verifyRealAdapterContract(): Promise<void> {
  let requestTimeout: number | undefined;
  const deletedFiles: string[] = [];
  const analyzer = new GeminiVideoAnalyzer(
    "hosted-contract-fake-key",
    "gemini-hosted-contract",
    {
      generateContent: async (parameters) => {
        requestTimeout = parameters.config?.httpOptions?.timeout;
        return {
          text: JSON.stringify({
            segments: [{
              start: "00:00:00",
              end: "00:00:01",
              speaker: "Speaker 1",
              text: "Hosted adapter transport contract.",
            }],
          }),
          usageMetadata: {
            promptTokenCount: 80,
            candidatesTokenCount: 20,
            totalTokenCount: 100,
          },
        };
      },
      deleteFile: async (parameters) => {
        deletedFiles.push(parameters.name);
        return {};
      },
    },
  );
  const provider = new GeminiHostedAnalysisProvider(analyzer);
  const file = (suffix: string) => ({
    name: `files/adapter_${suffix}`,
    uri: `https://generativelanguage.googleapis.test/v1beta/files/adapter_${suffix}`,
    mimeType: "video/mp4",
  });
  await provider.transcribe(file("timeout"));
  assertEqual(
    requestTimeout,
    MODEL_REQUEST_TIMEOUT_MS,
    "real hosted adapter model timeout",
  );
  console.log("HOSTED_WORKFLOW adapter_timeout=PASS");

  const ephemeralReceipt = (suffix: string): SealedHostedMediaReceipt => ({
    principalSub: principalA,
    mediaId: `media_adapter_${suffix}`,
    geminiFileName: `files/adapter_${suffix}`,
    geminiFileUri: `https://generativelanguage.googleapis.test/v1beta/files/adapter_${suffix}`,
    sha256: mediaSha256,
    sizeBytes: 1024,
    mimeType: "video/mp4",
    retention: "ephemeral",
    durationSeconds: 1,
    sealedAt: "2026-08-22T00:00:00.000Z",
    expiresAt: "2026-08-29T00:00:00.000Z",
  });
  await provider.cleanup(
    file("success"),
    ephemeralReceipt("success"),
  );
  await provider.cleanup(
    file("receipt_failure"),
    ephemeralReceipt("receipt_failure"),
  );
  assertEqual(
    deletedFiles,
    ["files/adapter_success", "files/adapter_receipt_failure"],
    "real hosted adapter ephemeral Files API deletes",
  );
  console.log(
    "HOSTED_WORKFLOW ephemeral_delete=PASS success=true failure=true",
  );
}

function d1Binding() {
  return {
    binding: "DB",
    database_name: databaseName,
    database_id: databaseId,
    migrations_dir: resolve("apps/web/db/migrations"),
  };
}

async function writeSeed(): Promise<void> {
  await writeFile(seedPath, seedSql());
  await runChecked([
    "node", wranglerBin, "d1", "execute", databaseName,
    "--local", "--config", webConfigPath, "--persist-to", persistRoot,
    "--file", seedPath,
  ], "hosted Workflow fixture seed");
}

async function betterAuthPrincipal(email: string): Promise<string> {
  const stdout = await runChecked([
    "node", wranglerBin, "d1", "execute", databaseName,
    "--local", "--config", webConfigPath, "--persist-to", persistRoot,
    "--command", `SELECT id FROM better_auth_user WHERE email = '${email}'`,
    "--json",
  ], `query Better Auth principal for ${email}`);
  const result = JSON.parse(stdout) as Array<{ results?: Array<{ id?: string }> }>;
  const id = result[0]?.results?.[0]?.id;
  if (!id) throw new Error(`Better Auth principal was unavailable for ${email}.`);
  return `ba:${id}`;
}

function seedSql(): string {
  const sealedAt = "2026-08-22T00:00:00.000Z";
  const expiresAt = "2026-08-29T00:00:00.000Z";
  const expiredAt = "2026-08-21T00:00:00.000Z";
  const mediaFixtures = [
    { principal: principalA, mediaId: normalMedia, retention: "retained", expiresAt },
    { principal: principalA, mediaId: crashMedia, retention: "ephemeral", expiresAt },
    { principal: principalA, mediaId: cancelMedia, retention: "retained", expiresAt },
    { principal: principalRace, mediaId: cancelMedia, retention: "retained", expiresAt },
    { principal: principalOverrun, mediaId: overrunMedia, retention: "retained", expiresAt },
    { principal: principalJanitor, mediaId: janitorMedia, retention: "retained", expiresAt: expiredAt },
    ...recipeStartMedia.map(({ mediaId }) => ({
      principal: principalB,
      mediaId,
      retention: "retained",
      expiresAt,
    })),
    { principal: principalB, mediaId: missingHashMedia, retention: "retained", expiresAt },
  ];
  const mediaRows = mediaFixtures.map(({ principal, mediaId, retention, expiresAt: mediaExpiresAt }) =>
      `('${principal}','${mediaId}','files/${mediaId}',`
      + `'https://generativelanguage.googleapis.test/v1beta/files/${mediaId}',`
      + `'${mediaSha256}','video/mp4','${retention}',`
      + `'${sealedAt}','${mediaExpiresAt}',1,1024)`
  );
  const janitorInput = JSON.stringify({
    mediaId: janitorMedia,
    mediaSha256,
    context: { mode: "none" },
    recipe: {
      id: "critical-decisions",
      label: "Critical decisions",
      revision: "builtin-test",
      sha256: "b".repeat(64),
    },
    model: "gemini-test",
    retention: "retained",
    spendPlan: contractSpendPlan,
  }).replaceAll("'", "''");
  const legacyDisplayInput = JSON.stringify({
    mediaId: legacyDisplayMedia,
    mediaSha256,
    context: { mode: "none" },
    recipe: {
      id: "issue-review",
      label: "Issue review",
      revision: "builtin-test",
      sha256: "b".repeat(64),
    },
    model: "gemini-test",
    retention: "retained",
    spendPlan: contractSpendPlan,
  }).replaceAll("'", "''");
  const foreignDisplayInput = JSON.stringify({
    mediaId: normalMedia,
    mediaSha256,
    context: { mode: "none" },
    recipe: {
      id: "issue-review",
      label: "Issue review",
      revision: "builtin-test",
      sha256: "b".repeat(64),
    },
    model: "gemini-test",
    retention: "retained",
    spendPlan: contractSpendPlan,
  }).replaceAll("'", "''");
  return `
    INSERT INTO hosted_principal_spend (
      principal_sub, principal_email, cap_units, committed_units, updated_at
    ) VALUES
      ('${principalA}', 'seat@example.test', ${principalACapUnits}, 0, '${sealedAt}'),
      ('${principalB}', 'seat@example.test', ${contractSpendPlan.estimatedTokens * (recipeStartMedia.length + 1)}, 0, '${sealedAt}'),
      ('${principalRace}', 'seat@example.test', ${raceCapUnits}, 0, '${sealedAt}'),
      ('${principalOverrun}', 'seat@example.test', ${contractSpendPlan.estimatedTokens * 2}, 0, '${sealedAt}'),
      ('${principalJanitor}', 'seat@example.test', ${contractSpendPlan.estimatedTokens}, 0, '${sealedAt}');
    INSERT INTO hosted_media_receipts (
      principal_sub, media_id, gemini_file_name, gemini_file_uri, sha256,
      mime_type, retention, sealed_at, expires_at, duration_seconds, size_bytes
    ) VALUES ${mediaRows.join(",\n")};
    INSERT INTO hosted_media_receipts (
      principal_sub, media_id, gemini_file_name, gemini_file_uri, sha256,
      mime_type, retention, sealed_at, expires_at, duration_seconds, size_bytes
    ) VALUES (
      '${principalA}', '${legacyDisplayMedia}', 'files/${legacyDisplayMedia}',
      'https://generativelanguage.googleapis.test/v1beta/files/${legacyDisplayMedia}',
      '${mediaSha256}', 'video/mp4', 'retained', '${sealedAt}', '${expiresAt}',
      20, NULL
    );
    INSERT INTO hosted_analysis_jobs (
      principal_sub, job_id, principal_email, media_id, created_at
    ) VALUES (
      '${principalA}', '${legacyDisplayJob}', 'seat@example.test',
      '${legacyDisplayMedia}', '${sealedAt}'
    );
    INSERT INTO hosted_analysis_attempts (
      principal_sub, attempt_id, job_id, retry_of_attempt_id,
      attempt_number, idempotency_key, workflow_instance_id,
      immutable_input_json, stage, spend_reserved_units, created_at, updated_at
    ) VALUES (
      '${principalA}', '${legacyDisplayAttempt}', '${legacyDisplayJob}', NULL,
      1, 'legacy-display-key', 'workflow_hosted_legacy_display_0001',
      '${legacyDisplayInput}', 'queued', ${contractSpendPlan.estimatedTokens},
      '${sealedAt}', '${sealedAt}'
    );
    INSERT INTO hosted_analysis_jobs (
      principal_sub, job_id, principal_email, media_id, created_at
    ) VALUES (
      '${principalB}', '${foreignDisplayJob}', 'seat@example.test',
      '${recipeStartMedia[0]!.mediaId}', '${sealedAt}'
    );
    INSERT INTO hosted_analysis_attempts (
      principal_sub, attempt_id, job_id, retry_of_attempt_id,
      attempt_number, idempotency_key, workflow_instance_id,
      immutable_input_json, stage, spend_reserved_units, created_at, updated_at
    ) VALUES (
      '${principalB}', '${foreignDisplayAttempt}', '${foreignDisplayJob}', NULL,
      1, 'foreign-display-key', 'workflow_hosted_foreign_display_0001',
      '${foreignDisplayInput}', 'queued', ${contractSpendPlan.estimatedTokens},
      '${sealedAt}', '${sealedAt}'
    );
    INSERT INTO hosted_analysis_jobs (
      principal_sub, job_id, principal_email, media_id, created_at
    ) VALUES (
      '${principalJanitor}', 'job_hosted_janitor_0001', 'seat@example.test',
      '${janitorMedia}', '${sealedAt}'
    );
    INSERT INTO hosted_analysis_attempts (
      principal_sub, attempt_id, job_id, retry_of_attempt_id,
      attempt_number, idempotency_key, workflow_instance_id,
      immutable_input_json, stage, spend_reserved_units, created_at, updated_at
    ) VALUES (
      '${principalJanitor}', '${janitorAttempt}', 'job_hosted_janitor_0001', NULL,
      1, 'janitor-expired-key', 'workflow_hosted_janitor_0001',
      '${janitorInput}', 'queued', ${contractSpendPlan.estimatedTokens},
      '${sealedAt}', '${sealedAt}'
    );
    INSERT INTO hosted_spend_reservations (
      principal_sub, attempt_id, reserved_units, state, created_at, updated_at
    ) VALUES (
      '${principalJanitor}', '${janitorAttempt}', ${contractSpendPlan.estimatedTokens},
      'reserved', '${sealedAt}', '${sealedAt}'
    );
  `;
}

async function verifyHostedBrowserContract(
  origin: string,
  token: string,
  mediaId: string,
): Promise<void> {
  const screenshotRoot = resolve("apps/web/e2e/__screenshots__/ux-pass-3");
  const captureScreenshots = hostedContractAuthMode === "cloudflare-access";
  if (captureScreenshots) {
    await rm(screenshotRoot, { recursive: true, force: true });
    await mkdir(screenshotRoot, { recursive: true });
  }
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext(hostedContractAuthMode === "cloudflare-access"
      ? { extraHTTPHeaders: hostedAuthHeaders(token) }
      : undefined);
    if (hostedContractAuthMode === "better-auth") {
      await context.addCookies(token.split("; ").map((part) => {
        const separator = part.indexOf("=");
        return { name: part.slice(0, separator), value: part.slice(separator + 1), url: origin };
      }));
    }
    const page = await context.newPage();
    const hydrationMismatches: string[] = [];
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.text().toLowerCase().includes("hydration")
        && message.text().toLowerCase().includes("mismatch")) {
        hydrationMismatches.push(`${new URL(page.url()).pathname}: ${message.text()}`);
      }
    });
    const capture = async (
      name: string,
      mobileFocusText?: string,
    ): Promise<void> => {
      assertEqual(await page.locator("h1").count(), 1, `${name} single h1`);
      assertEqual(hydrationMismatches, [], `${name} hydration mismatches`);
      if (!captureScreenshots) return;
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.screenshot({ path: join(screenshotRoot, `${name}-desktop.png`), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      if (mobileFocusText) {
        await page.getByText(mobileFocusText, { exact: true }).evaluate((element) => {
          element.scrollIntoView({ block: "end", inline: "nearest" });
        });
      }
      await page.screenshot({ path: join(screenshotRoot, `${name}-mobile.png`), fullPage: true });
      await page.setViewportSize({ width: 1280, height: 900 });
    };
    await page.goto(`${origin}/hosted/new/intent`);
    await capture("01-intent-empty");
    const directFocus = page.getByLabel("Optional focus");
    await directFocus.waitFor();
    await directFocus.fill("Direct-load label check");
    assertEqual(await directFocus.inputValue(), "Direct-load label check", "direct SSR Intent label binding");
    await directFocus.fill("");
    assertEqual(await page.getByRole("navigation").count(), 1, "single hosted navigation landmark");
    assertEqual(await page.getByRole("group", { name: "New analysis progress" }).count(), 1, "single composer progress group");
    assertEqual(await page.locator("[data-composer-step]").count(), 3, "three composer steps");
    const announcedSteps = await page.locator("[data-composer-step]").evaluateAll((steps) =>
      steps.map((step) => ({
        visible: step.querySelector("[aria-hidden=true]")?.textContent?.trim(),
        announced: step.querySelector(".sr-only")?.textContent?.trim(),
      }))
    );
    assertEqual(announcedSteps, [
      { visible: "1", announced: "Step 1 of 3:" },
      { visible: "2", announced: "Step 2 of 3:" },
      { visible: "3", announced: "Step 3 of 3:" },
    ], "visible and announced composer step numbers");
    const runStep = page.locator("[data-composer-step=run]");
    assertEqual(await runStep.isDisabled(), true, "Run step disabled before prerequisites");
    await runStep.click({ force: true });
    assertEqual(new URL(page.url()).pathname, "/hosted/new/intent", "disabled Run stays on Intent");
    const skipLink = page.getByRole("link", { name: "Skip to content" });
    await skipLink.focus();
    const skipBox = await skipLink.boundingBox();
    if (!skipBox || skipBox.width < 80 || skipBox.height < 20) {
      throw new Error("Focused skip link did not become visibly usable.");
    }
    await page.keyboard.press("Escape");
    const goalCards = page.locator("[aria-label^='Choose ']");
    const firstGoalBox = await goalCards.nth(0).boundingBox();
    const secondGoalBox = await goalCards.nth(1).boundingBox();
    if (!firstGoalBox || !secondGoalBox || firstGoalBox.y !== secondGoalBox.y) {
      throw new Error("Intent goals did not render two-up at the desktop breakpoint.");
    }
    await goalCards.first().hover();
    const hoverRing = await goalCards.first().evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        shadow: style.getPropertyValue("--tw-ring-shadow"),
        color: style.getPropertyValue("--tw-ring-color"),
      };
    });
    if (!hoverRing.shadow.includes("2px") || !hoverRing.color.trim()) {
      throw new Error("Intent goal hover ring was not emitted by the hosted Tailwind build.");
    }
    await page.goto(`${origin}/hosted/new/run`);
    await page.waitForURL(/\/hosted\/new\/intent\?reason=/);
    await page.getByText("Complete Intent before opening Run.").waitFor();
    const focus = page.getByLabel("Optional focus");
    await focus.waitFor();
    await focus.fill("Only the billing bug");
    await page.getByRole("button", { name: /Issue review/ }).click();
    const selectedRing = await page.getByRole("button", { name: "Choose Issue review" }).evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        shadow: style.getPropertyValue("--tw-ring-shadow"),
        color: style.getPropertyValue("--tw-ring-color"),
      };
    });
    if (!selectedRing.shadow.includes("2px") || !selectedRing.color.trim()) {
      throw new Error("Selected Intent goal ring was not emitted by the hosted Tailwind build.");
    }
    await capture("02-intent-selected");
    await page.goto(`${origin}/hosted/new/run`);
    await page.waitForURL(/\/hosted\/new\/recording\?reason=/);
    await page.getByText("Add a recording before Review & start.").waitFor();
    await page.getByText("Drop a recording here").waitFor();
    await page.getByRole("link", { name: "Back to Activity" }).waitFor();
    await page.getByText("Delete after analysis", { exact: true }).waitFor();
    await page.getByText(/An unfinished upload expires after 1 hour\./).waitFor();
    await page.getByText("Keep for 30 days", { exact: true }).waitFor();
    await assertRecordingCopyUsesUxGlossary(page);
    await capture("03-recording-empty", "Keep for 30 days");
    await page.evaluate((id) => {
      sessionStorage.setItem(
        "hosted:frame-of-mind:studio:media-upload",
        JSON.stringify({ schemaVersion: 1, mediaSessionId: id }),
      );
    }, mediaId);
    await page.reload();
    await page.locator("[data-hosted-media-ready=true]").waitFor();
    await page.getByText(/^Recording · 1 s · 1\.0 KB$/).waitFor();
    await page.getByRole("button", { name: "Replace" }).waitFor();
    assertEqual(await page.getByText("Drop a recording here").count(), 0, "ready recording collapses dropzone");
    await assertRecordingCopyUsesUxGlossary(page);
    await capture("04-recording-ready");
    await page.getByRole("link", { name: "Continue" }).click();
    await page.waitForURL(/\/hosted\/new\/run$/);
    await page.locator("[data-summary-card]").first().waitFor();
    assertEqual(await page.locator("[data-summary-card]").count(), 3, "three review summary cards");
    await page.getByText("Sources").waitFor();
    await page.getByText("Before you start").waitFor();
    await capture("05-review-and-start");
    const start = page.locator("[data-hosted-run-start=true]");
    await start.waitFor();
    const startErrorFixtures = [
      {
        code: "principal_spend_cap_exceeded",
        message: "You've used this account's analysis allowance.",
        nextAction: "Contact support with the code below to raise it.",
        action: "Copy support code",
        actionRole: "button" as const,
        status: 429,
      },
      {
        code: "spend_duration_unavailable",
        message: "We couldn't read this recording's length.",
        nextAction: "Upload the recording again.",
        action: "Upload recording again",
        actionRole: "link" as const,
        status: 422,
      },
      {
        code: "sealed_media_receipt_missing",
        message: "This recording is no longer ready.",
        nextAction: "Upload the recording again.",
        action: "Upload recording again",
        actionRole: "link" as const,
        status: 404,
      },
      {
        code: "media_retention_expired",
        message: "This recording's availability changed.",
        nextAction: "Return to Recording and upload it again.",
        action: "Upload recording again",
        actionRole: "link" as const,
        status: 409,
      },
      {
        code: "spend_policy_unavailable",
        message: "Analysis limits are temporarily unavailable.",
        nextAction: "Try starting the analysis again.",
        action: "Try again",
        actionRole: "button" as const,
        status: 503,
      },
      {
        code: "hosted_media_open_session_cap_exceeded",
        message: "Another recording upload is still unfinished.",
        nextAction: "Finish or discard it before starting this analysis.",
        action: "Finish or discard upload",
        actionRole: "link" as const,
        status: 429,
      },
      {
        code: "invalid_hosted_job_request",
        message: "These analysis selections are no longer valid.",
        nextAction: "Choose your analysis settings again.",
        action: "Choose again",
        actionRole: "link" as const,
        status: 422,
      },
      {
        code: "hosted_idempotency_conflict",
        message: "This start request no longer matches the saved analysis.",
        nextAction: "Refresh this page before trying again.",
        action: "Refresh page",
        actionRole: "button" as const,
        status: 409,
      },
    ];
    for (const fixture of startErrorFixtures) {
      await page.route("**/api/hosted/composer/jobs", async (route) => {
        await route.fulfill({
          status: fixture.status,
          contentType: "application/json",
          body: JSON.stringify({ data: { code: fixture.code } }),
        });
      }, { times: 1 });
      await start.click();
      await page.getByRole("alert").getByText(fixture.message, { exact: true }).waitFor();
      await page.getByRole("alert").getByText(fixture.nextAction, { exact: true }).waitFor();
      await page.getByText(`Support code: ${fixture.code}`, { exact: true }).waitFor();
      const errorAction = page.getByRole(fixture.actionRole, {
        name: fixture.action,
        exact: true,
      });
      await errorAction.waitFor();
      if (fixture.code === "principal_spend_cap_exceeded") {
        await page.evaluate(() => {
          Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: {
              writeText: () => Promise.reject(new Error("Clipboard permission denied")),
            },
          });
        });
        await errorAction.click();
        const supportCode = page.locator("code").filter({ hasText: fixture.code });
        assertEqual(await supportCode.textContent(), fixture.code, "clipboard fallback support code");
        assertEqual(
          await supportCode.evaluate((element) => getComputedStyle(element).userSelect === "none"),
          false,
          "clipboard fallback support code remains selectable",
        );
        assertEqual(pageErrors, [], "clipboard fallback page errors");
      }
    }
    await start.click();
    await page.waitForURL(/\/hosted\/activity\/attempt_/);
    await page.locator("[data-hosted-activity-page=detail]").waitFor();
    await page.getByRole("heading", { name: "Issue review", level: 1 }).waitFor();
    await page.getByRole("button", { name: "Copy details for support" }).waitFor();
    await page.getByText("Sending recording to Gemini", { exact: true }).first().waitFor();
    await page.locator("[role=progressbar]").waitFor();
    await capture("06-activity-running");
    const results = page.getByRole("link", { name: "View results" });
    await results.waitFor();
    await capture("07-activity-completed");
    await results.click();
    await page.waitForURL(/\/runs\/hosted_attempt_/);
    await page.getByRole("heading", { name: /Issue review ·/, level: 1 }).waitFor();
    await capture("08-run-viewer");
    await page.getByRole("link", { name: "Review findings" }).click();
    await page.waitForURL(/\/review\/hosted_attempt_/);
    await page.locator("[data-studio-review=hosted]").waitFor();
    const reviewColumns = await page.locator("[data-review-workspace-grid=true]").evaluate((element) =>
      getComputedStyle(element).gridTemplateColumns.split(" ").length
    );
    assertEqual(reviewColumns, 2, "hosted review desktop columns");
    await capture("09-review-workspace");
    const activityFixtures = hostedActivityFixtures();
    await page.goto(`${origin}/hosted/activity`);
    await page.locator("[data-hosted-activity-page=list]").waitFor();
    assertEqual(hydrationMismatches, [], "Activity SSR hydration mismatches");
    await page.route("**/api/hosted/jobs", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ jobs: activityFixtures }),
      });
    });
    await page.getByRole("button", { name: "Refresh" }).click();
    await page.getByText("Recording · 20 s · 954 KB", { exact: false }).waitFor();
    await page.getByText("Recording · 37 s · 1.2 MB", { exact: false }).waitFor();
    await capture("10-activity-list");
    await page.route("**/api/runs?*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          runs: activityFixtures.map((job, index) => ({
            schemaVersion: 3,
            contextMode: "none",
            runId: job.runId,
            recipeId: job.receipt.recipe.id,
            recipeLabel: job.receipt.recipe.label,
            model: job.receipt.model,
            startedAt: job.createdAt,
            completedAt: job.updatedAt,
            acceptedCount: index + 1,
            rejectedCount: 0,
            importedAt: job.updatedAt,
          })),
        }),
      });
    });
    await page.getByRole("link", { name: "Results", exact: true }).click();
    await page.waitForURL(`${origin}/`);
    await page.getByRole("heading", { name: "Your finished analyses.", level: 1 }).waitFor();
    await page.getByRole("columnheader", { name: "Goal" }).waitFor();
    await page.getByRole("columnheader", { name: "Sources" }).waitFor();
    await page.getByRole("link", { name: "Recording · 20 s · 954 KB" }).waitFor();
    await page.getByRole("link", { name: "Recording · 37 s · 1.2 MB" }).waitFor();
    const visibleResultsLabels = await page.getByText("Results", { exact: true }).evaluateAll((elements) =>
      elements.filter((element) => {
        const box = element.getBoundingClientRect();
        return box.width > 1 && box.height > 1;
      }).length
    );
    assertEqual(visibleResultsLabels, 1, "one visible Results label on published analyses screen");
    await capture("11-results-home");
    await page.unroute("**/api/runs?*");
    await page.unroute("**/api/hosted/jobs");
    await page.goto(`${origin}/import`);
    await page.getByRole("heading", { name: /Import/, level: 1 }).waitFor();
    await capture("12-import");
    await page.goto(`${origin}/hosted/activity/not-a-real-attempt`);
    await page.getByRole("heading", { name: "We couldn't find that analysis", level: 1 }).waitFor();
    await capture("13-not-found");
    assertEqual(hydrationMismatches, [], "hosted browser hydration mismatches");
    assertEqual(pageErrors, [], "hosted browser page errors");
    await context.close();
  } finally {
    await browser.close();
  }
  console.log("HOSTED_WORKFLOW browser=PASS composer_activity_published_viewer");
}

async function assertRecordingCopyUsesUxGlossary(
  page: import("@playwright/test").Page,
): Promise<void> {
  const copyGuide = await readFile(resolve("docs/UX_COPY.md"), "utf8");
  const glossary = copyGuide
    .split("\n")
    .filter((line) => line.startsWith("| ") && !line.includes("Internal term") && !line.startsWith("|---"))
    .flatMap((line) => (line.split("|")[1] ?? "")
      .replaceAll("`", "")
      .split(/\s+or\s+/)
      .map((term) => term.trim().toLowerCase())
      .filter(Boolean));
  const forbidden = [...new Set([...glossary, "session"])]
    .flatMap((term) => term.split(/\s+/))
    .filter((term) => /^[a-z]+$/.test(term));
  const rendered = (await page.locator("[data-hosted-composer=recording]").innerText()).toLowerCase();
  for (const term of forbidden) {
    if (new RegExp(`\\b${term}\\b`, "i").test(rendered)) {
      throw new Error(`Rendered hosted Recording copy exposed glossary term ${term}.`);
    }
  }
}

function hostedActivityFixtures() {
  const base = {
    rootJobId: "job_ux_pass_3",
    attempt: 1,
    stage: "succeeded" as const,
    cleanupCompleted: true,
    createdAt: "2026-08-23T08:00:00.000Z",
    updatedAt: "2026-08-23T08:01:00.000Z",
  };
  return [
    {
      ...base,
      id: "attempt_ux_pass_3_first",
      rootJobId: "job_ux_pass_3_first",
      runId: "run_ux_pass_3_first",
      receipt: {
        recipe: { id: "issue-review", label: "Issue review", revision: "ux-pass-3" },
        context: { mode: "none" as const },
        model: "gemini-test",
        retention: "ephemeral" as const,
        recording: { durationSeconds: 20, sizeBytes: 954_357 },
      },
    },
    {
      ...base,
      id: "attempt_ux_pass_3_second",
      rootJobId: "job_ux_pass_3_second",
      runId: "run_ux_pass_3_second",
      createdAt: "2026-08-23T09:00:00.000Z",
      updatedAt: "2026-08-23T09:01:00.000Z",
      receipt: {
        recipe: { id: "decisions", label: "Decisions", revision: "ux-pass-3" },
        context: { mode: "none" as const },
        model: "gemini-test",
        retention: "retained" as const,
        recording: { durationSeconds: 37, sizeBytes: 1_200_000 },
      },
    },
  ];
}

async function signAccessToken(
  privateKey: KeyLike,
  issuer: string,
  subject: string,
): Promise<string> {
  return new SignJWT({ sub: subject, email: "seat@example.test" })
    .setProtectedHeader({ alg: "RS256", kid: keyId })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

async function createJob(
  origin: string,
  token: string,
  mediaId: string,
  idempotencyKey: string,
  expectedStatus = 201,
): Promise<JobResponse> {
  return await json<JobResponse>(await expectOneOf(createJobResponse(
    origin,
    token,
    mediaId,
    idempotencyKey,
  ), expectedStatus === 201 ? [200, 201] : [expectedStatus], `create ${idempotencyKey}`));
}

async function createJobResponse(
  origin: string,
  token: string,
  mediaId: string,
  idempotencyKey: string,
): Promise<Response> {
  return await retryLocalDispatch(async () => fetch(`${origin}/api/hosted/jobs`, {
      method: "POST",
      headers: mutationHeaders(origin, token),
      body: JSON.stringify({
        idempotencyKey,
        mediaId,
        context: { mode: "none" },
        recipeId: "decisions",
      }),
    }));
}

function composerJobResponse(
  origin: string,
  token: string,
  mediaId: string,
  idempotencyKey: string,
  recipeId = "decisions",
  recipeRevision = "builtin-2026-07-27.1",
): Promise<Response> {
  return fetch(`${origin}/api/hosted/composer/jobs`, {
    method: "POST",
    headers: mutationHeaders(origin, token),
    body: JSON.stringify({
      idempotencyKey,
      mediaSessionId: mediaId,
      context: { mode: "none" },
      recipe: { id: recipeId, revision: recipeRevision },
      model: "gemini-3.7-flash",
      retention: { mode: "retained", ttlSeconds: 7 * 24 * 60 * 60 },
    }),
  });
}

async function retryJob(
  origin: string,
  token: string,
  attemptId: string,
  idempotencyKey: string,
): Promise<Response> {
  return await retryLocalDispatch(async () => fetch(`${origin}/api/hosted/jobs/${attemptId}/retry`, {
    method: "POST",
    headers: mutationHeaders(origin, token),
    body: JSON.stringify({ idempotencyKey }),
  }));
}

async function retryLocalDispatch(
  request: () => Promise<Response>,
): Promise<Response> {
  const initial = await request();
  if (!await isLocalDispatchFailure(initial)) return initial;
  const retry = dispatchRetryTail.then(async () => {
    let response = initial;
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      await response.body?.cancel();
      await Bun.sleep(100 * attempt);
      response = await request();
      if (!await isLocalDispatchFailure(response)) return response;
    }
    return response;
  });
  dispatchRetryTail = retry.then(() => undefined, () => undefined);
  return await retry;
}

async function isLocalDispatchFailure(response: Response): Promise<boolean> {
  const body = await response.clone().json().catch(() => undefined) as
    | { statusMessage?: string; data?: { code?: string } }
    | undefined;
  if (response.status === 503) {
    return body?.data?.code === "hosted_workflow_dispatch_failed";
  }
  return response.status === 500
    && body?.statusMessage === "Hosted job request failed."
    && body.data?.code === undefined;
}

function mutationHeaders(origin: string, token: string): Record<string, string> {
  return hostedAuthHeaders(token, origin);
}

function authenticatedFetch(origin: string, path: string, token: string): Promise<Response> {
  return fetch(`${origin}${path}`, {
    headers: hostedAuthHeaders(token),
  });
}

async function getJob(origin: string, token: string, id: string): Promise<JobDetail> {
  let response = await authenticatedFetch(origin, `/api/hosted/jobs/${id}`, token);
  for (let attempt = 1; attempt <= 10 && response.status === 500; attempt += 1) {
    await response.body?.cancel();
    await Bun.sleep(50 * attempt);
    response = await authenticatedFetch(origin, `/api/hosted/jobs/${id}`, token);
  }
  return await json<JobDetail>(await expectStatus(response, 200, `job ${id}`));
}

async function waitForTerminal(
  origin: string,
  token: string,
  id: string,
): Promise<JobDetail> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const detail = await getJob(origin, token, id);
    if (["succeeded", "failed", "canceled", "indeterminate"].includes(detail.job.stage)) {
      return detail;
    }
    await Bun.sleep(100);
  }
  throw new Error(`Hosted attempt ${id} did not become terminal.`);
}

async function waitForEvent(
  origin: string,
  token: string,
  id: string,
  code: string,
): Promise<JobDetail> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const detail = await getJob(origin, token, id);
    if (detail.events.some((event) => event.code === code)) return detail;
    await Bun.sleep(100);
  }
  throw new Error(`Hosted attempt ${id} did not record ${code}.`);
}

async function queryWorkflowInstanceId(attemptId: string): Promise<string> {
  const stdout = await runChecked([
    "node", wranglerBin, "d1", "execute", databaseName,
    "--local", "--config", webConfigPath, "--persist-to", persistRoot,
    "--command",
    `SELECT workflow_instance_id FROM hosted_analysis_attempts WHERE attempt_id = '${attemptId}'`,
    "--json",
  ], "query crashed Workflow instance ID");
  const result = JSON.parse(stdout) as Array<{
    results?: Array<{ workflow_instance_id?: string }>;
  }>;
  const workflowInstanceId = result[0]?.results?.[0]?.workflow_instance_id;
  if (!workflowInstanceId) throw new Error("Crashed Workflow instance ID was unavailable.");
  return workflowInstanceId;
}

async function queryCount(table: string, predicate: string): Promise<number> {
  const stdout = await runChecked([
    "node", wranglerBin, "d1", "execute", databaseName,
    "--local", "--config", webConfigPath, "--persist-to", persistRoot,
    "--command", `SELECT count(*) AS value FROM ${table} WHERE ${predicate}`,
    "--json",
  ], `query ${table} count`);
  return d1Scalar(stdout);
}

async function queryRaceFailureReceipt(): Promise<unknown> {
  const stdout = await runChecked([
    "node", wranglerBin, "d1", "execute", databaseName,
    "--local", "--config", webConfigPath, "--persist-to", persistRoot,
    "--command", `
      SELECT 'principal' AS row_type, principal_sub, NULL AS attempt_id,
        cap_units, committed_units, NULL AS reserved_units, NULL AS state,
        NULL AS idempotency_key
      FROM hosted_principal_spend
      WHERE principal_sub = '${principalRace}'
      UNION ALL
      SELECT 'reservation', principal_sub, attempt_id,
        NULL, NULL, reserved_units, state, NULL
      FROM hosted_spend_reservations
      WHERE principal_sub = '${principalRace}'
      UNION ALL
      SELECT 'attempt', principal_sub, attempt_id,
        NULL, NULL, spend_reserved_units, stage, idempotency_key
      FROM hosted_analysis_attempts
      WHERE principal_sub = '${principalRace}'
      ORDER BY row_type, attempt_id
    `,
    "--json",
  ], "query concurrent spend failure rows");
  return JSON.parse(stdout);
}

async function queryCommittedUnits(principalSub: string): Promise<number> {
  const stdout = await runChecked([
    "node", wranglerBin, "d1", "execute", databaseName,
    "--local", "--config", webConfigPath, "--persist-to", persistRoot,
    "--command",
    `SELECT committed_units AS value FROM hosted_principal_spend WHERE principal_sub = '${principalSub}'`,
    "--json",
  ], "query committed spend");
  return d1Scalar(stdout);
}

async function queryReservation(
  principalSub: string,
  attemptId: string,
): Promise<{
  state: string;
  reserved_units: number;
  actual_units: number;
  reconciliation_code: string;
}> {
  const stdout = await runChecked([
    "node", wranglerBin, "d1", "execute", databaseName,
    "--local", "--config", webConfigPath, "--persist-to", persistRoot,
    "--command",
    `SELECT state, reserved_units, COALESCE(actual_units, 0) AS actual_units, COALESCE(reconciliation_code, '') AS reconciliation_code FROM hosted_spend_reservations WHERE principal_sub = '${principalSub}' AND attempt_id = '${attemptId}'`,
    "--json",
  ], "query spend reservation");
  const result = JSON.parse(stdout) as Array<{
    results?: Array<{
      state?: string;
      reserved_units?: number;
      actual_units?: number;
      reconciliation_code?: string;
    }>;
  }>;
  const row = result[0]?.results?.[0];
  if (
    typeof row?.state !== "string"
    || !Number.isSafeInteger(row.reserved_units)
    || !Number.isSafeInteger(row.actual_units)
    || typeof row.reconciliation_code !== "string"
  ) {
    throw new Error("Spend reservation receipt was unavailable.");
  }
  return row as {
    state: string;
    reserved_units: number;
    actual_units: number;
    reconciliation_code: string;
  };
}

function d1Scalar(stdout: string): number {
  const result = JSON.parse(stdout) as Array<{
    results?: Array<{ value?: number }>;
  }>;
  const value = result[0]?.results?.[0]?.value;
  if (!Number.isSafeInteger(value)) {
    throw new Error("D1 scalar receipt was unavailable.");
  }
  return value as number;
}

async function expectStatus(
  responsePromise: Promise<Response> | Response,
  expected: number,
  label: string,
): Promise<Response> {
  const response = await responsePromise;
  if (response.status !== expected) {
    throw new Error(
      `${label}: expected HTTP ${expected}, received ${response.status}: ${await response.text()}`,
    );
  }
  return response;
}

async function expectOneOf(
  responsePromise: Promise<Response> | Response,
  expected: number[],
  label: string,
): Promise<Response> {
  const response = await responsePromise;
  if (!expected.includes(response.status)) {
    throw new Error(
      `${label}: expected HTTP ${expected.join("/")}, received ${response.status}: ${await response.text()}`,
    );
  }
  return response;
}

async function json<T>(response: Response): Promise<T> {
  return await response.json() as T;
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

async function startContractWorker(input: {
  configPath: string;
  persistRoot: string;
  port: number;
  readinessUrl: string;
  readinessStatus: number;
}) {
  const worker = Bun.spawn([
    "node", wranglerBin, "dev", "--local",
    "--config", input.configPath,
    "--persist-to", input.persistRoot,
    "--ip", "127.0.0.1",
    "--port", String(input.port),
    "--inspector-port", "0",
    "--log-level", "error",
    "--show-interactive-dev-session=false",
  ], {
    cwd: process.cwd(),
    env: createE2EEnvironment(process.env),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = Promise.all([
    new Response(worker.stdout).text(),
    new Response(worker.stderr).text(),
  ]);
  await waitForWorker(input.readinessUrl, worker, input.readinessStatus);
  return { worker, output };
}

async function stopContractWorker(
  worker: ReturnType<typeof Bun.spawn> | undefined,
  output: Promise<[string, string]> | undefined,
): Promise<void> {
  if (!worker || !output) {
    throw new Error("Hosted Workflow contract Worker restart state was incomplete.");
  }
  worker.kill("SIGTERM");
  await worker.exited;
  await output;
}

// Local D1 queries run as a second Miniflare process against the persisted
// database while the dev Workers still hold it. Miniflare occasionally answers
// "internal error" for that overlap; it is a harness race, not a state bug, so
// the query is retried a bounded number of times before the label fails.
async function runChecked(
  command: string[],
  label: string,
  additions: Record<string, string> = {},
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      return await runCheckedOnce(command, label, additions);
    } catch (error) {
      lastError = error;
      const text = error instanceof Error ? error.message : String(error);
      if (!label.startsWith("query ") || !text.includes("internal error")) throw error;
      await Bun.sleep(250 * attempt);
    }
  }
  throw lastError;
}

async function runCheckedOnce(
  command: string[],
  label: string,
  additions: Record<string, string> = {},
): Promise<string> {
  const child = Bun.spawn(command, {
    cwd: process.cwd(),
    env: createE2EEnvironment(process.env, additions),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${label} failed (${exitCode}):\n${stdout}\n${stderr}`.slice(0, 20_000));
  }
  return stdout;
}

async function waitForWorker(
  url: string,
  child: ReturnType<typeof Bun.spawn>,
  expectedStatus: number,
): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.status === expectedStatus) return;
    } catch {
      // workerd is still starting.
    }
    await Bun.sleep(100);
  }
  throw new Error("Hosted Workflow contract Workers did not become ready.");
}
