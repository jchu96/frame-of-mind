import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createE2EEnvironment } from "./e2e-environment";

const root = resolve(".");
const wrangler = resolve("apps/web/node_modules/.bin/wrangler");
const workflowConfig = resolve("apps/workflows/wrangler.spike.jsonc");
const nuxtConfig = resolve("apps/web/wrangler.hosted-workflow-spike.jsonc");
const temporaryRoot = await mkdtemp(join(tmpdir(), "frame-of-mind-hosted-workflow-"));
const workflowBundle = join(temporaryRoot, "workflow-dry-run");
const nuxtBundle = join(temporaryRoot, "nuxt-dry-run");
const workflowPort = await reservePort();
const nuxtPort = await reservePort();
const workflowOrigin = `http://127.0.0.1:${workflowPort}`;
const nuxtOrigin = `http://127.0.0.1:${nuxtPort}`;
const childEnvironment = createE2EEnvironment(process.env);

let workflowDev: ReturnType<typeof Bun.spawn> | undefined;
let nuxtDev: ReturnType<typeof Bun.spawn> | undefined;
let workflowOutput: Promise<[string, string]> | undefined;
let nuxtOutput: Promise<[string, string]> | undefined;

try {
  const nitro = await resolveNitroCloudflarePreset();
  const hasNamedExportSupport = nitro.preset.includes("setupEntryExports")
    || nitro.preset.includes("exports.cloudflare");
  if (hasNamedExportSupport) {
    throw new Error(
      "Pinned Nitro gained a named-export seam; re-evaluate topology A before accepting fallback B.",
    );
  }
  receipt(
    "same_module_export",
    false,
    `nitropack_${nitro.version.replaceAll(".", "_")}_has_default_entry_only`,
  );

  await runChecked(
    ["bun", "--no-env-file", "run", "--cwd", "apps/web", "nuxi", "build"],
    "Nuxt cloudflare_module spike build",
    {
      FRAME_OF_MIND_DB_DRIVER: "d1",
      FRAME_OF_MIND_HOSTED_WORKFLOW_SPIKE: "1",
      NITRO_PRESET: "cloudflare_module",
    },
  );
  const nuxtEntry = await Bun.file(resolve("apps/web/.output/server/index.mjs")).text();
  if (nuxtEntry.includes("HostedWorkflowSpike")) {
    throw new Error("Nuxt artifact unexpectedly owns the sibling Workflow class.");
  }
  receipt("nitro_build", true, "preset=cloudflare_module workflow_class=absent");

  const workflowDryRun = await runCaptured([
    wrangler,
    "deploy",
    "--dry-run",
    "--outdir",
    workflowBundle,
    "--config",
    workflowConfig,
  ], "sibling Workflow dry-run");
  const workflowArtifact = await readTree(workflowBundle);
  if (
    !workflowArtifact.includes("HostedWorkflowSpike")
    || !workflowArtifact.includes("WorkflowEntrypoint")
  ) {
    throw new Error("Workflow dry-run artifact omitted its exported WorkflowEntrypoint subclass.");
  }
  receipt("workflow_dry_run", true, "class=HostedWorkflowSpike binding=HOSTED_WORKFLOW");

  const nuxtDryRun = await runCaptured([
    wrangler,
    "deploy",
    "--dry-run",
    "--outdir",
    nuxtBundle,
    "--config",
    nuxtConfig,
  ], "Nuxt service-binding dry-run");
  const dryRunText = `${workflowDryRun.stdout}\n${workflowDryRun.stderr}\n${nuxtDryRun.stdout}\n${nuxtDryRun.stderr}`;
  if (!dryRunText.includes("HOSTED_WORKFLOWS")) {
    throw new Error("Nuxt dry-run did not report the HOSTED_WORKFLOWS service binding.");
  }
  receipt("nuxt_dry_run", true, "binding=HOSTED_WORKFLOWS target=frame-of-mind-hosted-workflows-spike");

  workflowDev = startWranglerDev(
    workflowConfig,
    workflowPort,
    join(temporaryRoot, "workflow-state"),
  );
  workflowOutput = captureOutput(workflowDev);
  await waitForOk(`${workflowOrigin}/health`, workflowDev, "sibling Workflow Worker");

  nuxtDev = startWranglerDev(
    nuxtConfig,
    nuxtPort,
    join(temporaryRoot, "nuxt-state"),
  );
  nuxtOutput = captureOutput(nuxtDev);
  await waitForOk(`${nuxtOrigin}/api/health`, nuxtDev, "Nuxt Worker");

  const createResponse = await fetch(`${nuxtOrigin}/api/__hosted-workflow-spike`, {
    method: "POST",
  });
  if (createResponse.status !== 200) {
    throw new Error(
      `Nuxt service-binding create returned ${createResponse.status}: ${await createResponse.text()}`,
    );
  }
  const created = await createResponse.json() as { instanceId?: unknown };
  if (typeof created.instanceId !== "string" || !created.instanceId) {
    throw new Error("Nuxt service-binding create omitted the Workflow instance ID.");
  }
  receipt("service_binding", true, "nuxt_to_sibling=connected");
  receipt("instance_create", true, "id=opaque");

  const status = await waitForWorkflow(nuxtOrigin, created.instanceId, nuxtDev);
  const output = status.output as Partial<{ first: number; second: string }> | undefined;
  if (output?.first !== 14) {
    throw new Error(`First Workflow step returned ${JSON.stringify(output?.first)} instead of 14.`);
  }
  receipt("step_one", true, "value=14");
  if (output.second !== "workflow-14") {
    throw new Error(
      `Second Workflow step returned ${JSON.stringify(output.second)} instead of workflow-14.`,
    );
  }
  receipt("step_two", true, "value=workflow-14");
  receipt("terminal_status", true, "status=complete");
  console.log("HOSTED_WORKFLOW_SPIKE PASSED");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.log("HOSTED_WORKFLOW_SPIKE FAILED");
  process.exitCode = 1;
} finally {
  await stop(nuxtDev);
  await stop(workflowDev);
  if (process.exitCode) {
    await printProcessOutput("Nuxt Worker", nuxtOutput);
    await printProcessOutput("Workflow Worker", workflowOutput);
  } else {
    await Promise.all([nuxtOutput, workflowOutput].filter(Boolean));
  }
  await rm(temporaryRoot, { recursive: true, force: true });
}

function receipt(check: string, passed: boolean, detail: string): void {
  console.log(`HOSTED_WORKFLOW ${check}=${passed ? "PASS" : "FAIL"} ${detail}`);
}

async function resolveNitroCloudflarePreset(): Promise<{
  preset: string;
  version: string;
}> {
  const resolverBase = resolve("node_modules/.bun/node_modules");
  const presetPath = Bun.resolveSync(
    "nitropack/presets/cloudflare/preset",
    resolverBase,
  );
  const packagePath = Bun.resolveSync("nitropack/package.json", resolverBase);
  const packageJson = await Bun.file(packagePath).json() as { version?: unknown };
  if (typeof packageJson.version !== "string") {
    throw new Error("Installed nitropack package metadata omitted its version.");
  }
  return {
    preset: await Bun.file(presetPath).text(),
    version: packageJson.version,
  };
}

async function runChecked(
  command: string[],
  label: string,
  additions: Record<string, string> = {},
): Promise<void> {
  const child = Bun.spawn(command, {
    cwd: root,
    env: createE2EEnvironment(process.env, additions),
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0) throw new Error(`${label} exited with ${code}.`);
}

async function runCaptured(
  command: string[],
  label: string,
): Promise<{ stdout: string; stderr: string }> {
  const child = Bun.spawn(command, {
    cwd: root,
    env: childEnvironment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) {
    throw new Error(`${label} exited with ${code}:\n${stdout}\n${stderr}`.slice(0, 12_000));
  }
  return { stdout, stderr };
}

function startWranglerDev(
  config: string,
  port: number,
  persistTo: string,
): ReturnType<typeof Bun.spawn> {
  return Bun.spawn([
    wrangler,
    "dev",
    "--local",
    "--config",
    config,
    "--persist-to",
    persistTo,
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--log-level",
    "info",
    "--show-interactive-dev-session=false",
  ], {
    cwd: root,
    env: childEnvironment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

function captureOutput(
  child: ReturnType<typeof Bun.spawn>,
): Promise<[string, string]> {
  return Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
}

async function waitForOk(
  url: string,
  child: ReturnType<typeof Bun.spawn>,
  label: string,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  let lastResponse = "no response";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${label} exited before readiness.`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastResponse = `HTTP ${response.status}: ${await response.text()}`;
    } catch {
      // workerd is still starting.
    }
    await Bun.sleep(100);
  }
  throw new Error(`${label} did not become ready (${lastResponse}).`);
}

async function waitForWorkflow(
  origin: string,
  instanceId: string,
  child: ReturnType<typeof Bun.spawn>,
): Promise<{ status: string; output?: unknown }> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("Nuxt Worker exited while polling the Workflow.");
    const response = await fetch(
      `${origin}/api/__hosted-workflow-spike/${encodeURIComponent(instanceId)}`,
    );
    if (!response.ok) {
      throw new Error(`Workflow status returned ${response.status}: ${await response.text()}`);
    }
    const status = await response.json() as { status: string; output?: unknown };
    if (status.status === "complete") return status;
    if (["errored", "terminated", "unknown"].includes(status.status)) {
      throw new Error(`Workflow reached terminal status ${status.status}.`);
    }
    await Bun.sleep(100);
  }
  throw new Error("Workflow did not complete before the spike deadline.");
}

async function reservePort(): Promise<number> {
  const reservation = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("reserved"),
  });
  const port = reservation.port;
  await reservation.stop(true);
  return port;
}

async function readTree(directory: string): Promise<string> {
  const chunks: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) chunks.push(await readTree(path));
    else chunks.push(await Bun.file(path).text());
  }
  return chunks.join("\n");
}

async function stop(child: ReturnType<typeof Bun.spawn> | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await child.exited;
}

async function printProcessOutput(
  label: string,
  output: Promise<[string, string]> | undefined,
): Promise<void> {
  if (!output) return;
  const [stdout, stderr] = await output;
  const text = `${label} output:\n${stdout}\n${stderr}`.slice(0, 12_000);
  if (text.trim()) process.stderr.write(`${text}\n`);
}
