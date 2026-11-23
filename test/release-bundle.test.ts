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
const noticesFile = "THIRD-PARTY-NOTICES.txt";
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
  const inputs = ["scripts/build-release.mjs", "scripts/release-notices", "LICENSE", "package.json", "bun.lock", "tsconfig.json", ".gitignore"];
  for (const input of [...sources, ...inputs]) {
    await cp(input, join(first, input), { recursive: true });
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
  expect(files).toEqual(["LICENSE", "SHA256SUMS", noticesFile, "frameofmind.mjs", "release.json"]);
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
  for (const name of [noticesFile, "frameofmind.mjs", "release.json", "SHA256SUMS", "LICENSE"]) {
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

function releaseWorkflow() {
  const yaml = 'console.log(JSON.stringify(Bun.YAML.parse(await Bun.file(".github/workflows/ci.yml").text())))';
  return JSON.parse(execFileSync("bun", ["--no-env-file", "-e", yaml], { encoding: "utf8" }));
}

it("restricts the write job to checked version-tag pushes", () => {
  const workflow = releaseWorkflow();
  expect(workflow.permissions).toEqual({ contents: "read" });
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (name !== "release") expect((job as { permissions?: { contents?: string } }).permissions?.contents).not.toBe("write");
  }
  expect(workflow.on.push.tags).toEqual(["v*"]);
  expect(workflow.jobs.release.needs).toBe("check");
  expect(workflow.jobs.release.if).toBe("github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')");
  expect(workflow.jobs.release.permissions).toEqual({ contents: "write" });
});

it("lists exactly the packages with bytes in the bundle and reproduces their notices", async () => {
  // Read an independent build's output contributions and installed manifests.
  const metaPath = join(scratch, "reference-meta.json");
  await exec("bun", ["--no-env-file", "--no-install", "build", "src/cli.ts", "--target=node",
    "--format=esm", "--packages=bundle", "--minify-whitespace", "--env=disable",
    "--define", `__FRAMEOFMIND_RELEASE_VERSION__=${JSON.stringify(version)}`,
    `--outfile=${join(scratch, "reference.mjs")}`, `--metafile=${metaPath}`]);
  const meta = JSON.parse(await readFile(metaPath, "utf8"));
  const roots = new Set<string>();
  const inputs: Record<string, { bytesInOutput: number }> = meta.outputs["./reference.mjs"].inputs;
  for (const [file, input] of Object.entries(inputs)) {
    const match = file.match(/^(.*\bnode_modules\/(?:@[^/]+\/)?[^/]+)\//);
    if (match && input.bytesInOutput > 0) roots.add(match[1]);
  }
  const notices = await readFile(join(first, "release", noticesFile), "utf8");
  const [index, ...sections] = notices.split("\n----- ");
  const packages = [];
  for (const root of roots) {
    const { name, version: resolved, license } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    packages.push({ root, name, key: `${name}@${resolved}`, row: `${name}\t${resolved}\t${license}` });
  }
  const listed = index.split("\n").filter(line => line.includes("\t"));
  expect(listed, "bundled packages versus notices inventory").toEqual([...new Set(packages.map(pkg => pkg.row))].sort());
  expect(sections).toHaveLength(listed.length);
  for (const { root, name, key } of packages) {
    const section = sections.find(value => value.startsWith(`${key} -----\n`));
    const ownFiles = (await readdir(root)).filter(file => /^(licen[cs]e|copying)(\.(txt|md))?$/i.test(file));
    for (const file of ownFiles) {
      expect(section?.includes(await readFile(join(root, file), "utf8")), `${key} missing ${file}`).toBe(true);
    }
    const extra: Record<string, string[]> = {
      "@sentry/server-utils": ["build/THIRD-PARTY-LICENSES.txt"],
      "@opentelemetry/instrumentation": ["LICENSES/shimmer/LICENSE"],
      "import-in-the-middle": ["NOTICE", "LICENSE-3rdparty.csv"],
    };
    for (const file of extra[name] ?? []) {
      expect(section?.includes(await readFile(join(root, file), "utf8")), `${key} missing ${file}`).toBe(true);
    }
    if (name === "data-uri-to-buffer") {
      const readme = await readFile(join(root, "README.md"), "utf8");
      expect(section?.includes(readme.slice(readme.indexOf("(The MIT License)"), readme.indexOf("[rfc]:")).trim())).toBe(true);
    }
    if (name === "@sentry/server-utils") {
      const upstream = await readFile("scripts/release-notices/overrides/sentry-server-utils-10.73.0.LICENSE", "utf8");
      expect(section?.includes(upstream)).toBe(true);
      expect(section).toContain("https://github.com/getsentry/sentry-javascript/blob/f109d922f5971e2ade549b6c755524168b101818/LICENSE");
    }
  }
});

async function packageFixture(name: string, pkgVersion: string) {
  const cwd = await mkdtemp(join(scratch, "package-"));
  git(cwd, "clone", "--quiet", first, ".");
  await writeFile(join(cwd, "src/cli.ts"), `import value from "${name}"; console.log(value);`);
  await writeFile(join(cwd, "bun.lock"), JSON.stringify({ packages: { [name]: [`${name}@${pkgVersion}`, "", {}] } }));
  const root = join(cwd, "node_modules", name);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name, version: pkgVersion, license: "MIT", main: "index.js" }));
  await writeFile(join(root, "index.js"), 'module.exports = "fixture";');
  return { cwd, root };
}

function commitFixture(cwd: string) {
  git(cwd, "add", "-u");
  git(cwd, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false",
    "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "-qm", "Fixture inputs");
}

it("refuses to publish a bundled package with missing licence text", async () => {
  const { cwd } = await packageFixture("notice-fixture", "1.0.0");
  commitFixture(cwd);
  await expect(build(cwd)).rejects.toThrow(/Missing licence text for notice-fixture@1\.0\.0/);
  await expect(readdir(join(cwd, "release"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("rejects a different override version, a changed digest and a stale override", async () => {
  for (const fault of ["version", "digest", "stale"] as const) {
    const v = fault === "version" ? "10.73.1" : "10.73.0";
    const { cwd, root } = await packageFixture("@sentry/server-utils", v);
    if (fault === "digest") {
      await writeFile(join(cwd, "scripts/release-notices/overrides/sentry-server-utils-10.73.0.LICENSE"), "Changed");
    }
    if (fault === "stale") await writeFile(join(root, "LICENSE"), "Installed fixture licence");
    commitFixture(cwd);
    const reason = { version: "Missing licence text for", digest: "Licence digest mismatch for", stale: "Stale licence override for" }[fault];
    await expect(build(cwd), fault).rejects.toThrow(`${reason} @sentry/server-utils@${v}`);
    await expect(readdir(join(cwd, "release"))).rejects.toMatchObject({ code: "ENOENT" });
  }
});

function publishArgs(tag: string) {
  const step = releaseWorkflow().jobs.release.steps.find((s: { name?: string }) => s.name === "Publish the verified files");
  // Exercise Bash expansion and flag placement without contacting GitHub.
  const fake = `gh() {
    case "$1 $2" in
      "api "*) git rev-parse HEAD ;;
      "release create") printf '%s\\0' "$@" ;;
      *) return 1 ;;
    esac
  }`;
  return execFileSync("bash", ["-eu", "-o", "pipefail", "-c", fake + "\n" + step.run], {
    cwd: first, encoding: "utf8", env: { PATH: process.env.PATH, GITHUB_REF_NAME: tag, GITHUB_REPOSITORY: "fixture/release" },
  }).split("\0").filter(Boolean);
}

it("publishes exactly the files written by the release build", async () => {
  const args = publishArgs("v1.2.3");
  const files = args.filter(arg => arg.startsWith("release/")).map(arg => arg.slice(8)).sort();
  expect(files, "published files versus release directory").toEqual((await readdir(join(first, "release"))).sort());
  expect(args[args.indexOf("--notes") + 1]).toContain("automatic instrumentation of third-party modules is off");
});

it("marks only tags with a pre-release suffix as pre-release and never latest", () => {
  for (const [tag, pre] of [["v1.2.3-beta.1", true], ["v1.2.3", false], ["v1.2.3+build-a", false]] as const) {
    const args = publishArgs(tag);
    expect(args.slice(0, 3)).toEqual(["release", "create", tag]);
    expect(args.includes("--prerelease"), `${tag} --prerelease`).toBe(pre);
    expect(args.includes("--latest=false"), `${tag} --latest=false`).toBe(pre);
  }
});

it("keeps both bundled versions and excludes an unused side-effect-free package", async () => {
  const { cwd, root } = await packageFixture("notice-fixture", "1.0.0");
  const nested = join(root, "node_modules", "notice-fixture");
  const unused = join(cwd, "node_modules", "unused-fixture");
  await mkdir(nested, { recursive: true });
  await mkdir(unused, { recursive: true });
  await writeFile(join(root, "LICENSE"), "First version licence");
  await writeFile(join(nested, "LICENSE"), "Second version licence");
  await writeFile(join(nested, "package.json"), JSON.stringify({ name: "notice-fixture", version: "2.0.0", license: "ISC" }));
  await writeFile(join(unused, "package.json"), JSON.stringify({ name: "unused-fixture", version: "1.0.0", sideEffects: false }));
  await writeFile(join(unused, "index.js"), 'export const unused = "removed";');
  await writeFile(join(nested, "index.js"), 'module.exports = "nested";');
  await writeFile(join(root, "index.js"), 'module.exports = require("notice-fixture") + "outer";');
  await writeFile(join(cwd, "src/cli.ts"), 'import "unused-fixture"; import value from "notice-fixture"; console.log(value);');
  await writeFile(join(cwd, "bun.lock"), JSON.stringify({ packages: {
    "notice-fixture": ["notice-fixture@1.0.0", "", {}],
    "notice-fixture/notice-fixture": ["notice-fixture@2.0.0", "", {}],
    "unused-fixture": ["unused-fixture@1.0.0", "", {}],
  } }));
  commitFixture(cwd);
  await build(cwd);
  const notices = await readFile(join(cwd, "release", noticesFile), "utf8");
  expect(notices).toContain("notice-fixture\t1.0.0\tMIT\nnotice-fixture\t2.0.0\tISC");
  expect(notices).toContain("First version licence");
  expect(notices).toContain("Second version licence");
  expect(notices).not.toContain("unused-fixture");
});
