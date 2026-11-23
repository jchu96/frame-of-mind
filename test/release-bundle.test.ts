import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildCliFixture } from "./helpers/cli-build.js";

const exec = promisify(execFile);
const version = JSON.parse(await readFile("package.json", "utf8")).version;
const canary = "synthetic-release-build-marker";
let scratch: string;
let first: string;
let second: string;
let reference: string;
let consumer: string;

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function build(cwd: string, tag = `v${version}`) {
  return exec(process.execPath, ["scripts/build-release.mjs", tag], {
    cwd, env: { PATH: process.env.PATH, GEMINI_API_KEY: canary },
  });
}

function cli(entry: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return exec(process.execPath, [entry, ...args], {
    cwd: consumer, env: { HOME: consumer, PATH: "", ...env },
  });
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "frameofmind-release-"));
  first = join(scratch, "first");
  second = join(scratch, "other-checkout");
  consumer = join(scratch, "consumer");
  await mkdir(consumer);
  await mkdir(join(first, "scripts"), { recursive: true });

  // Commit the working build inputs, including edits under test, into a fixture.
  // Both independent checkouts use exactly this commit and the locked install.
  const sources = git(".", "ls-files", "-z", "--", "src").split("\0").filter(Boolean);
  const inputs = ["scripts/build-release.mjs", "LICENSE", "package.json", "bun.lock", "tsconfig.json", ".gitignore"];
  for (const input of [...sources, ...inputs]) {
    await cp(input, join(first, input));
  }
  git(first, "init", "--quiet");
  git(first, "add", ".");
  git(first, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false",
    "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "-qm", "Release inputs");
  git(scratch, "clone", "--quiet", first, second);
  for (const cwd of [first, second]) {
    await symlink(resolve("node_modules"), join(cwd, "node_modules"), "junction");
    await writeFile(join(cwd, ".env"), `GEMINI_API_KEY=${canary}-dotenv\n`);
    await build(cwd);
  }
  reference = await buildCliFixture();
  await cp(join(first, "release/frameofmind.mjs"), join(consumer, "frameofmind.mjs"));
}, 90_000);

afterAll(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
  if (reference) await rm(reference, { recursive: true, force: true });
});

it("runs the release smoke from an empty directory and checks the embedded version", async () => {
  const result = await exec(process.execPath, [
    "scripts/smoke-release.mjs", join(first, "release/frameofmind.mjs"),
  ]);
  expect(result.stdout).toContain(`RELEASE_SMOKE version=${version} status=PASS`);
  await expect(build(second, "invalid-tag")).rejects.toThrow("tag must equal");
});

it("publishes a checksum for every payload exactly once", async () => {
  const cwd = join(first, "release");
  const files = (await readdir(cwd)).sort();
  expect(files).toEqual(["LICENSE", "SHA256SUMS", "frameofmind.mjs", "release.json"]);
  const lines = (await readFile(join(cwd, "SHA256SUMS"), "utf8")).trimEnd().split("\n");
  expect(lines.map(line => line.replace(/^[a-f0-9]{64}  /, "")).sort())
    .toEqual(files.filter(name => name !== "SHA256SUMS"));
  for (const name of files.filter(name => name !== "SHA256SUMS")) {
    const digest = createHash("sha256").update(await readFile(join(cwd, name))).digest("hex");
    expect(lines).toContain(`${digest}  ${name}`);
  }
});

it("records the actual commit, package version and build tools", async () => {
  const metadata = JSON.parse(await readFile(join(first, "release/release.json"), "utf8"));
  expect(metadata).toEqual({
    version, commit: git(first, "rev-parse", "HEAD"), node: process.versions.node,
    bun: execFileSync("bun", ["--version"], { encoding: "utf8" }).trim(),
  });
});

it("rebuilds identical release bytes in separate checkouts", async () => {
  for (const name of ["frameofmind.mjs", "release.json", "SHA256SUMS", "LICENSE"]) {
    const bytes = await readFile(join(first, "release", name));
    expect(bytes.equals(await readFile(join(second, "release", name))), `${name} bytes differ`).toBe(true);
  }
});

it("keeps environment values and build paths out of the bundle", async () => {
  const bundle = await readFile(join(first, "release/frameofmind.mjs"), "utf8");
  for (const marker of [resolve("."), first, canary]) {
    expect(bundle.includes(marker), "bundle contains build path or environment marker").toBe(false);
  }
  // The interactive key command constructs its assignment from terminal input.
  expect(/\bGEMINI_API_KEY\s*=(?!=|\$\{)/.test(bundle), "bundle contains key assignment").toBe(false);
});

it("preserves help and the complete registered command and option tree", async () => {
  const entries = [join(reference, "dist/cli.js"), join(consumer, "frameofmind.mjs")];
  const help = await Promise.all(entries.map(entry => cli(entry, ["--help"])));
  expect(help[1].stdout).toBe(help[0].stdout);
  const inspect = `
    import { pathToFileURL } from "node:url";
    globalThis[Symbol.for("frameofmind.cli.libraryImport")] = true;
    const { program } = await import(pathToFileURL(process.argv[1]));
    const tree = c => [c.name(), c.options.map(o => o.flags), c.commands.map(tree)];
    console.log(JSON.stringify(tree(program)));
  `;
  const trees = await Promise.all(entries.map(entry => exec(process.execPath, ["--input-type=module", "-e", inspect, entry], {
    cwd: consumer, env: { HOME: consumer, PATH: "" },
  })));
  expect(trees[1].stdout).toEqual(trees[0].stdout);
});

// Observe the real entry and the real Sentry transport. An unsupported local
// extension fails inside the command span, before any Gemini request.
it("sends the CLI transaction and scrubbed error without registering a bundle loader", async () => {
  const observations: unknown[] = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const body = request.headers["content-encoding"] === "gzip" ? gunzipSync(bytes) : bytes;
    const [, ...items] = body.toString().trimEnd().split("\n");
    for (let i = 0; i < items.length; i += 2) {
      const { type } = JSON.parse(items[i]);
      const event = JSON.parse(items[i + 1]);
      if (type === "transaction") {
        const names = event.spans.map((span: { description: string }) => span.description);
        observations.push([type, event.transaction, event.contexts.trace.op, names]);
      } else if (type === "event") {
        observations.push([type, event.exception.values]);
      } else {
        observations.push([type]);
      }
    }
    response.end("{}");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing loopback port");
    const preload = join(scratch, "observe-loader.cjs");
    await writeFile(preload, `
      const mod = require("node:module");
      const register = mod.register;
      mod.register = function (specifier, ...args) {
        process.stderr.write("LOADER_ATTEMPT " + specifier + "\\n");
        return register.call(this, specifier, ...args);
      };
      mod.syncBuiltinESMExports();
    `);
    await writeFile(join(consumer, "sample.unsupported"), "");
    const expected = [
      ["transaction", "analyze run", "gen_ai.invoke_agent", []],
      ["event", [{ type: "SanitizedTelemetryError", value: "analysis_failed" }]],
    ];
    for (const [index, entry] of [join(reference, "dist/cli.js"), join(consumer, "frameofmind.mjs")].entries()) {
      observations.length = 0;
      const result = await exec(process.execPath, ["--require", preload, entry,
        "analyze", "--source", "none", "--video", "sample.unsupported", "--output", consumer], {
        cwd: consumer, env: {
          HOME: consumer, PATH: "", GEMINI_API_KEY: "synthetic-fixture",
          FRAME_OF_MIND_TRACING: "1", SENTRY_DSN: `http://local@127.0.0.1:${address.port}/1`,
        },
      }).then(() => { throw new Error("Expected unsupported media to fail"); }, error => error);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Unsupported recording extension");
      if (index === 0) expect(result.stderr).toContain("LOADER_ATTEMPT import-in-the-middle/hook.mjs");
      else expect(result.stderr).not.toMatch(/LOADER_ATTEMPT|ERR_MODULE_NOT_FOUND|Cannot find module/);
      expect(observations).toEqual(expected);
    }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 20_000);

it("restricts the write job to checked version-tag pushes", () => {
  const yaml = 'console.log(JSON.stringify(Bun.YAML.parse(await Bun.file(".github/workflows/ci.yml").text())))';
  const workflow = JSON.parse(execFileSync("bun", ["--no-env-file", "-e", yaml], { encoding: "utf8" }));
  expect(workflow.on.push.tags).toEqual(["v*"]);
  expect(workflow.jobs.release.needs).toBe("check");
  expect(workflow.jobs.release.if).toBe("github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')");
  expect(workflow.jobs.release.permissions).toEqual({ contents: "write" });
});
