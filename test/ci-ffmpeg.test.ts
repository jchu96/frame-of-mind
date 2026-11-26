import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

const processTestTimeout = 60_000;

const installer = resolve("scripts/install-ci-ffmpeg.py");
const installCommand = "python3 scripts/install-ci-ffmpeg.py";
const keyCommand = installCommand + ' key >> "$GITHUB_OUTPUT"';
const digest = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ci-ffmpeg-"));
  roots.push(root);
  for (const dir of ["scripts", "commands", "ci-ffmpeg-debs"]) mkdirSync(join(root, dir));
  const name = "ffmpeg_1-2_amd64v3.deb";
  const pin = join(root, "scripts/ci-ffmpeg.lock");
  writeFileSync(pin, `snapshot 20261123T000000Z\n${digest("official")} 7:1-2 pool/universe/f/ffmpeg/${name}\n`);
  const pathFile = join(root, "path");
  const calls = join(root, "calls");
  writeFileSync(calls, "");
  const env: Record<string, string> = {
    PATH: join(root, "commands") + ":" + process.env.PATH, RUNNER_TEMP: root,
    ImageOS: "ubuntu26", RUNNER_ARCH: "X64", GITHUB_PATH: pathFile,
    FFMPEG_CACHE_HIT: "", CALLS: calls, PACKAGE: "official", VERSION: "1-2",
    ENCODERS: " V....D libx264 H.264\n A..... aac AAC", MISSING: "",
  };
  function command(name: string, script: string) {
    writeFileSync(join(root, "commands", name), "#!/bin/sh\nset -eu\n" + script, { mode: 0o755 });
  }
  for (const name of ["curl", "apt-get", "apt", "sudo"]) {
    command(name, name === "curl"
      ? 'echo fetch >> "$CALLS"\ntest "$1" = "--disable"\nwhile [ "$1" != "--output" ]; do shift; done\nprintf %s "$PACKAGE" > "$2"'
      : 'echo "$0 $*" >> "$CALLS"\ncase "$*" in "update"|"apt-get update"|"apt-get install -y ffmpeg") exit 0;; *) exit 1;; esac');
  }
  command("dpkg-deb", `test "$1" = "-x" && test -f "$2"
echo extract >> "$CALLS"
lib="$3/usr/lib/x86_64-linux-gnu"
mkdir -p "$3/usr/bin" "$lib"
cat > "$lib/ld-linux-x86-64.so.2" <<'LOADER'
#!/bin/sh
while [ "$1" != "--library-path" ]; do shift; done
shift 2
if [ "$1" = "--list" ]; then test -x "$2"; exit; fi
exec "$@"
LOADER
chmod +x "$lib/ld-linux-x86-64.so.2"
for tool in ffmpeg ffprobe; do
  [ "$MISSING" != "$tool" ] || continue
  cat > "$3/usr/bin/$tool" <<'TOOL'
#!/bin/sh
case "$*" in
  *-version) echo "\${0##*/} version $VERSION Copyright fixture" ;;
  *-encoders) printf '%s\\n' "$ENCODERS" ;;
  *) exit 2 ;;
esac
TOOL
  chmod +x "$3/usr/bin/$tool"
done`);
  return {
    env, pin, pathFile, cache: join(root, "ci-ffmpeg-debs", name),
    calls: () => readFileSync(calls, "utf8").trim().split("\n").filter(Boolean),
    run: (...args: string[]) => spawnSync("python3", [installer, ...args], { cwd: root, env, encoding: "utf8" }),
  };
}

it.each(["miss", "hit"])("refuses altered bytes on a cache %s before installing", mode => {
  const f = fixture();
  if (mode === "hit") {
    f.env.FFMPEG_CACHE_HIT = "true";
    writeFileSync(f.cache, "officiaL");
  } else {
    f.env.PACKAGE = "officiaL";
  }
  const result = f.run();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(`expected ${digest("official")}, actual ${digest("officiaL")}`);
  expect(f.calls()).toEqual(mode === "hit" ? [] : ["fetch"]);
  expect(existsSync(f.pathFile)).toBe(false);
}, processTestTimeout);

it.each(["miss", "hit"])("installs verified tools on a cache %s", mode => {
  const f = fixture();
  if (mode === "hit") {
    f.env.FFMPEG_CACHE_HIT = "true";
    writeFileSync(f.cache, "official");
  }
  const result = f.run();
  expect(result.status, result.stderr).toBe(0);
  expect(f.calls()).toEqual(mode === "hit" ? ["extract"] : ["fetch", "extract"]);
  const bin = readFileSync(f.pathFile, "utf8").trim();
  for (const tool of ["ffmpeg", "ffprobe"]) {
    expect(execFileSync(join(bin, tool), ["-version"], { env: f.env, encoding: "utf8" })).toContain(tool + " version 1-2 ");
  }
}, processTestTimeout);

it.each([
  ["wrong version", "VERSION", "2-9"],
  ["missing ffprobe", "MISSING", "ffprobe"],
  ["missing H.264", "ENCODERS", " A..... aac AAC"],
  ["missing AAC", "ENCODERS", " V....D libx264 H.264"],
])("refuses %s before publishing tools", (_case, variable, value) => {
  const f = fixture();
  f.env[variable!] = value!;
  expect(f.run().status).toBe(1);
  expect(existsSync(f.pathFile)).toBe(false);
}, processTestTimeout);

it("keys the cache by the pin bytes, runner image and architecture", () => {
  const f = fixture();
  function key() {
    const result = f.run("key");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^key=.+/);
    return result.stdout;
  }
  const base = key();
  f.env.ImageOS = "ubuntu28";
  expect(key()).not.toBe(base);
  f.env.ImageOS = "ubuntu26";
  f.env.RUNNER_ARCH = "ARM64";
  expect(key()).not.toBe(base);
  f.env.RUNNER_ARCH = "X64";
  writeFileSync(f.pin, readFileSync(f.pin, "utf8").replace(digest("official"), digest("other")));
  expect(key()).not.toBe(base);
}, processTestTimeout);

type Step = { id?: string; uses?: string; run?: string; env?: Record<string,string>; with?: Record<string,string>; "timeout-minutes"?: number };
type Job = { steps: Step[]; "runs-on": string; "timeout-minutes": number };
const yaml = 'console.log(JSON.stringify(Bun.YAML.parse(await Bun.file(".github/workflows/ci.yml").text()).jobs))';
const jobs: Record<string, Job> = JSON.parse(execFileSync("bun", ["--no-env-file", "-e", yaml], { encoding: "utf8" }));
it("runs the bounded, verified install before every media gate", () => {
  const media = Object.entries(jobs).filter(([, job]) => job.steps.some(step => step.run?.includes("bun run check:pr")));
  expect(media.map(([id]) => id)).toEqual(expect.arrayContaining(["check", "serial-check"]));
  for (const [id, job] of media) {
    expect(job["runs-on"], id).toBe("ubuntu-26.04");
    const gate = job.steps.findIndex(step => step.run?.includes("bun run check:pr"));
    const before = job.steps.slice(0, gate);
    const key = before.findIndex(step => step.id === "ffmpeg-key" && step.run === keyCommand);
    const cache = before.findIndex(step => step.id === "ffmpeg-cache" && step.uses?.startsWith("actions/cache@"));
    const install = before.findIndex(step => step.run === installCommand);
    expect(key, id).toBeGreaterThanOrEqual(0);
    expect(cache, id).toBeGreaterThan(key);
    expect(install, id).toBeGreaterThan(cache);
    expect(before[cache]!.with).toEqual({ path: "${{ runner.temp }}/ci-ffmpeg-debs", key: "${{ steps.ffmpeg-key.outputs.key }}" });
    expect(before[install]!.env?.FFMPEG_CACHE_HIT).toBe("${{ steps.ffmpeg-cache.outputs.cache-hit }}");
    const limit = before[install]!["timeout-minutes"] ?? 0;
    expect(limit, id).toBeGreaterThan(0);
    expect(limit, id).toBeLessThan(job["timeout-minutes"]);
  }
});
