import {execFileSync} from "node:child_process";
import {readFile, readdir} from "node:fs/promises";
import {join} from "node:path";
import {expect, test, vi} from "vitest";
import {createGeminiFileUploader} from "../src/adapters/gemini-files.js";
import {GeminiVideoAnalyzer} from "../src/adapters/gemini.js";
import {fixtureSource} from "./helpers/source-clock.js";
import {childEnvironment} from "../src/lib/child-env.js";
import {builtInRecipe} from "../src/recipes/index.js";
import {AnalysisOrchestrator} from "../src/services/analyze.js";
import {mediaHelper} from "../src/services/media-helpers.js";
import {mediaFixtures} from "./helpers/media-fixtures.js";

const file = mediaFixtures(dir => {
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=sample_rate=44100:duration=3",
    "-c:a", "alac", join(dir, "sound.mp4")], {env: childEnvironment("media")});
});

test.each([false, true])("analyze publishes native sample positions without stills (range %s)", async ranged => {
  const screenshot = vi.fn(async () => false);
  const upload = vi.fn(async (_path: string, _mime: string) => ({name:"files/test"}));
  const service = new AnalysisOrchestrator({
    createContextSource() { throw new Error("Unexpected context."); },
    createAnalyzer: () => ({
      model:"gemini-test", upload, delete:async () => {},
      index:async () => ({matchNotes:"fixture", moments:[{start:"00:00:00", end:"00:00:01", kind:"test", summary:"one", importance:"high"}]}),
      interrogate:async () => ({accepted:true, kind:"test", title:"Cue", summary:"one",
        evidence:{timestamp:"00:00:00", verbatimUiText:"invented screen quote"}}),
    }),
    extractScreenshot:screenshot,
  });
  const run = await service.analyze({video:file("sound.mp4"), ...(ranged && {from:"44101samp", to:"88202samp"}),
    outputRoot:file("analysis"), contextMode:"none", apiKey:"fixture", recipe:builtInRecipe("decisions"),
    customRecipe:false, recipeSha256:"a".repeat(64), recipeRevision:"fixture", maxIncidents:1,
    screenshots:true, calibrate:false, derivedTranscript:false, keepUpload:false});
  expect(upload.mock.calls).toEqual([ranged ? [expect.stringMatching(/cut\.wav$/), "audio/wav"] : [file("sound.mp4"), "audio/m4a"]]);
  const item = run.analysis.items[0]!;
  const start = {unit:"sample", samples:ranged ? "44101" : "0", rate:{num:44100, den:1}};
  expect(item.candidate).toMatchObject({start:ranged ? "00:00:01" : "00:00:00", end:ranged ? "00:00:02" : "00:00:01", exactSpan:{
    start, endExclusive:{...start, samples:ranged ? "88201" : "44100"}}});
  expect(item.result.evidence).toMatchObject({timestamp:item.candidate.start, exactTime:start});
  expect(item.result.evidence).not.toHaveProperty("verbatimUiText");
  expect(screenshot).not.toHaveBeenCalled();
  for (const field of ["screenshot", "screenshotExactTime", "stillTimes", "exactStillTimes"]) {
    expect(item).not.toHaveProperty(field);
  }
  expect((await readdir(run.directory)).filter(name => name.endsWith(".png"))).toEqual([]);
  const report = await readFile(join(run.directory, "analysis.md"), "utf8");
  expect(report.split("\n").slice(0, 6).join("\n")).toMatch(/no picture.*no stills/i);
});

test("asking for a frame of the same sound-only recording gives a pre-send reason", async () => {
  await expect(mediaHelper("frame", file("sound.mp4"), {at:"0f", output:file("still.png")}))
    .rejects.toMatchObject({details:{reason:"no-video-stream", phase:"prepare", sent:false}});
});

test.each(["start", "finalize"] as const)("an upload %s failure reports whether media could have left", async phase => {
  const requests: string[] = [];
  const uploader = createGeminiFileUploader("fixture", {fetch: async (_url, init) => {
    const op = new Headers(init?.headers).get("x-goog-upload-command")!;
    requests.push(op);
    if (phase === "start" || op === "upload, finalize") throw new TypeError("connection lost");
    return new Response(null, {headers:{"x-goog-upload-url":"https://generativelanguage.googleapis.com/upload/fixture"}});
  }});
  const service = new AnalysisOrchestrator({
    withSourceRecording: fixtureSource(() => 3), probeDurationSeconds: async () => 3,
    createContextSource() { throw new Error("Unexpected context."); },
    createAnalyzer: () => new GeminiVideoAnalyzer("fixture", "gemini-test", {fileUploader:uploader}),
  });
  let folder: string | undefined;
  const root = file("failure-" + phase);
  const failure = service.analyze({video:file("sound.mp4"), outputRoot:root, contextMode:"none",
    apiKey:"fixture", recipe:builtInRecipe("decisions"), customRecipe:false, recipeSha256:"a".repeat(64),
    recipeRevision:"fixture", maxIncidents:1, screenshots:true, calibrate:false, derivedTranscript:false,
    keepUpload:false}, {onFailurePublished: path => {folder = path;}});
  if (phase === "start") {
    await expect(failure).rejects.toMatchObject({details:{phase:"prepare", sent:false}});
    expect(requests).toEqual(["start"]);
    expect(folder).toBeUndefined();
    expect(await readdir(root)).toEqual([]);
  } else {
    await expect(failure).rejects.not.toHaveProperty("details.sent");
    expect(requests).toEqual(["start", "upload, finalize"]);
    const manifest = JSON.parse(await readFile(join(folder!, "failure-manifest.json"), "utf8"));
    expect(manifest).toMatchObject({phase:"upload", remoteFile:{cleanup:"unconfirmed"}});
    expect(manifest).not.toHaveProperty("sent");
  }
});
