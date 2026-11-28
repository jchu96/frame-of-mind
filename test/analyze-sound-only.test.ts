import {execFileSync} from "node:child_process";
import {readFile, readdir} from "node:fs/promises";
import {join} from "node:path";
import {expect, test, vi} from "vitest";
import {childEnvironment} from "../src/lib/child-env.js";
import {builtInRecipe} from "../src/recipes/index.js";
import {AnalysisOrchestrator} from "../src/services/analyze.js";
import {mediaHelper} from "../src/services/media-helpers.js";
import {mediaFixtures} from "./helpers/media-fixtures.js";

const file = mediaFixtures(dir => {
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=sample_rate=44100:duration=3",
    "-c:a", "alac", join(dir, "sound.mp4")], {env: childEnvironment("media")});
});

test("analyze publishes the sound-only cut in source samples and takes no stills", async () => {
  const screenshot = vi.fn(async () => false);
  const upload = vi.fn(async (_path: string, _mime: string) => ({name:"files/test"}));
  const service = new AnalysisOrchestrator({
    createAnalyzer: () => ({
      model:"gemini-test", upload, delete:async () => {},
      index:async () => ({matchNotes:"fixture", moments:[{start:"00:00:00", end:"00:00:01", kind:"test", summary:"one", importance:"high"}]}),
      interrogate:async () => ({accepted:true, kind:"test", title:"Cue", summary:"one",
        evidence:{timestamp:"00:00:00", verbatimUiText:"invented screen quote"}}),
    }),
    extractScreenshot:screenshot,
  });
  const run = await service.analyze({video:file("sound.mp4"), from:"44101samp", to:"88202samp",
    outputRoot:file("analysis"), contextMode:"none", apiKey:"fixture", recipe:builtInRecipe("decisions"),
    customRecipe:false, recipeSha256:"a".repeat(64), recipeRevision:"fixture", maxIncidents:1,
    screenshots:true, calibrate:false, derivedTranscript:false, keepUpload:false});
  expect(upload.mock.calls).toEqual([[expect.stringMatching(/cut\.wav$/), "audio/wav"]]);
  const item = run.analysis.items[0]!;
  const start = {unit:"sample", samples:"44101", rate:{num:44100, den:1}};
  expect(item.candidate).toMatchObject({start:"00:00:01", end:"00:00:02", exactSpan:{
    start, endExclusive:{...start, samples:"88201"}}});
  expect(item.result.evidence).toMatchObject({timestamp:"00:00:01", exactTime:start});
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
