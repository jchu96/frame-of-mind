import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, test } from "vitest";
import { mapTimeline } from "../src/services/timeline-map.js";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/timeline-export-${name}.otio`, import.meta.url));
const at = (path: string, frame: number, options = {}) => mapTimeline(path, { at: `${frame}f`, ...options });
const dirs: string[] = [];
async function temp() {
  const dir = await mkdtemp(join(tmpdir(), "sequence-map-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

test("repeated source frames map in both directions up to the exclusive sequence end", async () => {
  const path = fixture("23976");
  const first = (await at(path, 0)).rows;
  expect(first).toMatchObject([{ status: "source", trackName: "Video 1", clip: "count-a-23976.mov", fileValue: "48", mediaFrame: "48" }]);
  expect((await at(path, 100)).rows).toMatchObject([{ status: "source", trackName: "Video 1", clip: "count-b-23976-tc1h.mov", fileValue: "86500", mediaFrame: "100" }]);
  expect(await at(path, 288)).toMatchObject({ status: "outside the sequence", rows: [] });
  if (first[0]?.status !== "source") throw new Error("Missing source");
  expect((await mapTimeline(path, { source: first[0].path, frame: "48" })).rows).toMatchObject([
    { trackName: "Video 1", sequenceFrame: "0" }, { trackName: "Video 1", sequenceFrame: "168" },
  ]);
});

test("sequence frame 10 refuses the speed clip", async () => {
  const [speed] = (await at(fixture("refusals"), 10)).rows;
  expect(speed?.status).toBe("refused");
  expect(speed).toMatchObject({ clip: "count-a-23976.mov", reason: expect.stringContaining("LinearTimeWarp") });
});

test("the gap, clear cut, transition handles and nested edit resolve per lookup", async () => {
  const path = fixture("refusals");
  expect((await at(path, 150)).rows).toMatchObject([{ status: "gap" }]);
  const clear = (await at(path, 200)).rows;
  expect(clear).toMatchObject([{ clip: "count-b-23976-tc1h.mov", fileValue: "86480" }]);
  const transition = { status: "transition", clips: ["count-b-23976-tc1h.mov", "count-b-23976-tc1h.mov"] };
  expect((await at(path, 280)).rows).toMatchObject([transition]);
  if (clear[0]?.status !== "source") throw new Error("Missing source");
  // Incoming clip at the same dissolve, eight frames before its trim.
  expect((await mapTimeline(path, { source: clear[0].path, frame: "86632" })).rows).toMatchObject([
    { ...transition, sequenceFrame: "280" }, { status: "nested" },
  ]);
  expect((await at(path, 400)).rows).toMatchObject([{ status: "nested", clip: "OTIO SAMPLE 23976" }]);
});

test("stacked clips retain video track order and selection at a nonzero sequence start", async () => {
  const time = (value: number) => ({ OTIO_SCHEMA: "RationalTime.1", value, rate: 24 });
  const range = { OTIO_SCHEMA: "TimeRange.1", start_time: time(0), duration: time(5) };
  const track = (name: string) => ({ OTIO_SCHEMA: "Track.1", kind: "Video", name, children: [
    { OTIO_SCHEMA: "Clip.1", name, source_range: range, media_reference: {
      OTIO_SCHEMA: "ExternalReference.1", target_url: name + ".mov", available_range: range,
    } },
  ] });
  const path = join(await temp(), "stack.otio");
  await writeFile(path, JSON.stringify({ OTIO_SCHEMA: "Timeline.1", global_start_time: time(24),
    tracks: { OTIO_SCHEMA: "Stack.1", children: [track("lower"), track("upper")] } }));
  expect((await at(path, 2)).rows).toMatchObject([{ track: 2, clip: "upper" }, { track: 1, clip: "lower" }]);
  expect(await mapTimeline(path, { at: "00:00:01:02", track: "1" })).toMatchObject({
    sequenceFrame: "2", rows: [{ track: 1, fileValue: "2" }],
  });
});

test("source timecode needs a readable agreeing file tag", async () => {
  const dir = await temp();
  const path = join(dir, "df.otio");
  const movie = join(dir, "-tagged.mov");
  const plain = join(dir, "plain.mov");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=s=16x16:r=30000/1001",
    "-frames:v", "1", "-c:v", "mpeg4", "-timecode", "01:00:00;00", movie,
    "-frames:v", "1", "-c:v", "mpeg4", plain]);
  const timeline = JSON.parse(await readFile(fixture("2997df"), "utf8"));
  const ref = timeline.tracks.children[0].children[0].media_references.DEFAULT_MEDIA;
  async function lookup(media: string, start = 107892) {
    ref.target_url = pathToFileURL(media).href;
    ref.available_range.start_time.value = start;
    await writeFile(path, JSON.stringify(timeline));
    return (await at(path, 0)).rows[0];
  }
  expect(await lookup(movie)).toMatchObject({ fileValue: "107952", mediaFrame: "60", sourceTimecode: "01;00;02;00" });
  for (const [row, reason] of [
    [await lookup(plain), "no timecode tag"], [await lookup(movie, 107893), "disagrees"],
    [await lookup(join(dir, "missing.mov")), "missing source file"],
  ] as const) {
    expect(row).toMatchObject({ fileValue: "107952", sourceTimecodeReason: expect.stringContaining(reason) });
    expect(row).not.toHaveProperty("sourceTimecode");
  }
}, 1250);

test("sequence labels use the first verified mode and retain the reason for a fallback", async () => {
  const path = join(await temp(), "edit.otio");
  const original = fixture("2997df");
  await writeFile(path, await readFile(original));
  const sidecar = path + ".sequence.json";
  const raw = JSON.parse(await readFile(original + ".sequence.json", "utf8"));
  const video = path + ".mov";
  const packet = (extra = "") => `<x:xmpmeta><xmpDM:altTimecode xmpDM:timeFormat="2997DropTimecode"/>` +
    `<xmpDM:startTimecode xmpDM:timeFormat="2997NonDropTimecode"/>${extra}</x:xmpmeta>`;
  await writeFile(video, packet());
  const lookup = (flags = {}) => at(path, 0, { video, ...flags });
  await writeFile(sidecar, JSON.stringify(raw));
  expect(await lookup({ timecodeRate: "29.97ndf" })).toMatchObject({ mode: { basis: "flag", dropFrame: false } });
  expect(await lookup()).toMatchObject({ mode: { basis: "sidecar", dropFrame: true }, sequenceTimecodes: [{ mode: "drop-frame" }] });
  for (const [override, reason] of [
    [{ dropFrame: null }, "unknown"], [{ ticksPerFrame: "10594584000" }, "rate differs"],
    [{ zeroPointTicks: "8475667200" }, "zero point differs"], [{ ticksPerFrame: "7" }, "accepted rate"],
  ] as const) {
    await writeFile(sidecar, JSON.stringify({ sequence: { ...raw.sequence, ...override } }));
    expect(await lookup()).toMatchObject({ mode: { basis: "video", dropFrame: false, notes: [expect.stringContaining(reason)] } });
  }
  await rm(sidecar);
  for (const data of [packet('<xmpDM:startTimecode xmpDM:timeFormat="2997DropTimecode"/>'),
    '<x:xmpmeta><xmpDM:altTimecode xmpDM:timeFormat="2997DropTimecode"/></x:xmpmeta>']) {
    await writeFile(video, data);
    expect(await lookup()).toMatchObject({ mode: { basis: "unknown" }, sequenceTimecodes: [{ mode: "non-drop" }, { mode: "drop-frame" }] });
  }
});
