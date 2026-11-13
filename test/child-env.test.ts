import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { childEnvironment } from "../src/lib/child-env.js";
import { extractAudioTrack, probeDurationSeconds } from "../src/services/audio.js";
import { extractScreenshot } from "../src/services/screenshots.js";
import { probeFrameRate } from "../src/services/media-probe.js";
import { synthesizeFlash } from "../src/adapters/gemini-calibration.js";
import { openBrowser } from "../src/adapters/bluedot-oauth.js";

const markers = { GEMINI_API_KEY: "synthetic-key", BLUEDOT_ACCESS_TOKEN: "synthetic-token", FOM_TEST_MARKER_7: "synthetic-marker" };
const parent = process.env;
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "child-env-test-"));
  // Only synthetic values may reach the capture file, including on a mutant run.
  process.env = { PATH: root, HOME: root, TMPDIR: root, LANG: "C", ...markers };
  const script = `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(join(root, "env.json"))}, JSON.stringify(process.env));
const args = process.argv.slice(2);
if (process.argv[1].endsWith('ffprobe')) console.log(args.includes('format=duration') ? '2' : JSON.stringify({ streams: [{r_frame_rate:'1/1',avg_frame_rate:'1/1',time_base:'1/1'}], frames: [{pts:0,duration:1},{pts:1,duration:1}] }));
else if (process.argv[1].endsWith('ffmpeg')) fs.writeFileSync(args.at(-1), 'synthetic-output');
`;
  for (const name of ["ffmpeg", "ffprobe", "open", "xdg-open"]) await writeFile(join(root, name), script, { mode: 0o700 });
});
afterEach(async () => {
  process.env = parent;
  Object.defineProperty(process, "platform", platform);
  await rm(root, { recursive: true, force: true });
});
async function captured() { return JSON.parse(await readFile(join(root, "env.json"), "utf8")); }
async function noMarkers() {
  const env = await captured();
  for (const name of Object.keys(markers)) expect(env, name).not.toHaveProperty(name);
}

describe("helper", () => {
  it("an unlisted variable with an innocuous name is not passed", async () => {
    await extractScreenshot("synthetic.mp4", "00:00:00", join(root, "frame.jpg"));
    await noMarkers();
    expect(childEnvironment("media")).not.toHaveProperty("FOM_TEST_MARKER_7");
  });
  it("a Windows-style Path is carried under its own spelling", () => {
    const source = { Path: "C:\\tools", SystemRoot: "C:\\Windows", PATHEXT: ".EXE", ComSpec: "C:\\Windows\\cmd.exe", ...markers };
    expect(childEnvironment("media", source, "win32")).toEqual({ Path: source.Path, SystemRoot: source.SystemRoot, PATHEXT: ".EXE" });
    expect(childEnvironment("opener", source, "win32").ComSpec).toBe(source.ComSpec);
    expect(childEnvironment("media", source, "linux")).toEqual({});
  });
  it("keeps runtime paths and locale without forwarding arbitrary desktop variables", () => {
    const source = { PATH: "/bin", LD_LIBRARY_PATH: "/lib", DYLD_LIBRARY_PATH: "/lib", DYLD_FALLBACK_LIBRARY_PATH: "/lib", HOME: "/home/test", TMPDIR: "/tmp", TMP: "/tmp", TEMP: "/tmp", LANG: "C", LANGUAGE: "en", LC_ALL: "C", LC_TIME: "C" };
    expect(childEnvironment("media", { ...source, DISPLAY: ":7", LC_PRIVATE_TOKEN: "synthetic", XDG_PRIVATE_TOKEN: "synthetic" })).toEqual(source);
    expect(childEnvironment("opener", { XDG_RUNTIME_DIR: "/run/test", XDG_DATA_DIRS: "/data", XDG_PRIVATE_TOKEN: "synthetic", BROWSER: "browser" })).toEqual({ XDG_RUNTIME_DIR: "/run/test", XDG_DATA_DIRS: "/data", BROWSER: "browser" });
  });
});
describe("media", () => {
  it("audio extraction's ffmpeg sees no marker variable", async () => {
    expect(await extractAudioTrack("synthetic.mp4", join(root, "audio.aac"))).toBe(true); await noMarkers();
  });
  it("the duration ffprobe sees no marker variable", async () => {
    expect(await probeDurationSeconds("synthetic.mp4")).toBe(2); await noMarkers();
  });
  it("the screenshot ffmpeg sees no marker variable", async () => {
    expect(await extractScreenshot("synthetic.mp4", "00:00:00", join(root, "frame.jpg"))).toBe(true); await noMarkers();
  });
  it("the frame-rate ffprobe sees no marker variable", async () => {
    expect((await probeFrameRate("synthetic.mp4")).rate).toEqual({ num: 1, den: 1 }); await noMarkers();
  });
  it("the calibration ffmpeg sees no marker variable", async () => {
    expect(await synthesizeFlash(join(root, "flash.mp4"))).toBe(true); await noMarkers();
  });
  it("stub ffmpeg is found through the allowed path", async () => {
    expect(await extractScreenshot("synthetic.mp4", "00:00:00", join(root, "frame.jpg"))).toBe(true);
    expect((await captured()).PATH).toBe(root);
  });
});
describe("opener", () => {
  it("the browser opener sees no marker variable", async () => {
    expect(await openBrowser(new URL("https://example.invalid/"))).toBe(true); await noMarkers();
  });
  it("DISPLAY and DBUS_SESSION_BUS_ADDRESS reach xdg-open", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    Object.assign(process.env, { DISPLAY: ":7", DBUS_SESSION_BUS_ADDRESS: "unix:path=/synthetic-bus" });
    expect(await openBrowser(new URL("https://example.invalid/"))).toBe(true);
    expect(await captured()).toMatchObject({ DISPLAY: ":7", DBUS_SESSION_BUS_ADDRESS: "unix:path=/synthetic-bus" }); await noMarkers();
  });
});

// Incident: 2026-11-13 marker reached all media children through implicit env.
// Retire when process starts move to a single enforced boundary with equivalent coverage.
const sites: Record<string, { api: string; calls: number; kind: string }> = {
  "services/audio.ts": { api: "spawn", calls: 2, kind: "media" },
  "services/screenshots.ts": { api: "spawn", calls: 1, kind: "media" },
  "services/media-probe.ts": { api: "execFile", calls: 1, kind: "media" },
  "adapters/gemini-calibration.ts": { api: "execFile", calls: 1, kind: "media" },
  "adapters/bluedot-oauth.ts": { api: "spawn", calls: 1, kind: "opener" },
};
describe("guard", () => {
  it("every process start in src goes through the helper", async () => {
    const src = join(import.meta.dirname, "../src");
    const seen: string[] = [];
    async function scan(dir: string): Promise<void> {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) { await scan(path); continue; }
        if (!/\.[cm]?[jt]sx?$/.test(path)) continue;
        const file = relative(src, path).replaceAll("\\", "/");
        const source = ts.createSourceFile(file, await readFile(path, "utf8"), ts.ScriptTarget.Latest, true);
        const site = sites[file];
        let imports = 0, calls = 0, adapters = 0;
        function visit(node: ts.Node) {
          // Check module access, not just function names: every child_process API,
          // aliases, require(), dynamic imports and re-exports need review.
          if (ts.isStringLiteralLike(node) && /^(node:)?child_process$/.test(node.text)) {
            expect(site, file).toBeDefined();
            expect(node.parent.getText(source), file).toBe(`import { ${site!.api} } from "node:child_process";`);
            imports++;
          }
          if ((ts.isIdentifier(node) && node.text === "Bun") || (ts.isStringLiteralLike(node) && ["bun", "Bun"].includes(node.text))) {
            throw new Error(`${file}: Bun process APIs require the child environment boundary`);
          }
          if (site && ts.isIdentifier(node) && [site.api, ...(site.api === "execFile" ? ["exec"] : [])].includes(node.text)) {
            const p = node.parent;
            if (ts.isImportSpecifier(p)) { /* checked above */ }
            else if (node.text === "execFile" && ts.isCallExpression(p) && p.getText(source) === "promisify(execFile)") { adapters++; }
            else if (node.text === "exec" && ts.isVariableDeclaration(p) && p.initializer?.getText(source) === "promisify(execFile)") { /* adapter binding */ }
            else {
              expect(ts.isCallExpression(p) && p.expression === node, file).toBe(true);
              const options = (p as ts.CallExpression).arguments[2];
              expect(options && ts.isObjectLiteralExpression(options), file).toBe(true);
              const properties = (options as ts.ObjectLiteralExpression).properties;
              expect(properties.some(ts.isSpreadAssignment), file).toBe(false);
              const env = properties.filter(prop => prop.name?.getText(source) === "env");
              expect(env.map(prop => prop.getText(source)), file).toEqual([`env: childEnvironment("${site.kind}")`]);
              calls++;
            }
          }
          ts.forEachChild(node, visit);
        }
        visit(source);
        if (site) {
          expect({ imports, calls, adapters }, file).toEqual({ imports: 1, calls: site.calls, adapters: site.api === "execFile" ? 1 : 0 });
          expect(source.text, file).toContain('import { childEnvironment } from "../lib/child-env.js";');
          seen.push(file);
        }
      }
    }
    await scan(src);
    expect(seen.sort()).toEqual(Object.keys(sites).sort());
  });
});
