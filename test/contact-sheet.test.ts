import { execFileSync } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildContactSheet,
  contactSheetLabel,
  contactSheetLayout,
  drawLabel,
} from "../src/services/contact-sheet.js";

describe("contact sheet layout", () => {
  it("labels a tile with its record number and cited time", () => {
    expect(contactSheetLabel({ record: 3, time: "00:01:14", screenshot: "moment-05.png" })).toBe("#3  00:01:14");
  });

  it("tiles up to four columns", () => {
    expect(contactSheetLayout(1)).toMatchObject({ columns: 1, rows: 1 });
    expect(contactSheetLayout(4)).toMatchObject({ columns: 4, rows: 1 });
    expect(contactSheetLayout(7)).toMatchObject({ columns: 4, rows: 2 });
  });

  it("draws label pixels inside the canvas only", () => {
    const width = 40;
    const canvas = Buffer.alloc(width * 30 * 3);
    drawLabel(canvas, width, 1, 1, "#1");
    expect(canvas.some((value) => value > 0)).toBe(true);
    expect(() => drawLabel(canvas, width, 35, 25, "88:88")).not.toThrow();
  });

  it("keeps a label at its own position when given a fractional row", () => {
    const width = 200;
    const canvas = Buffer.alloc(width * 40 * 3);
    drawLabel(canvas, width, 2, 10.5, "#1");
    let maxX = 0;
    for (let offset = 0; offset < canvas.length; offset += 3) {
      if (canvas[offset]! > 0) maxX = Math.max(maxX, (offset / 3) % width);
    }
    // "#1" is two 5x7 glyphs at scale 3 starting at x=2: nothing past x=40.
    expect(maxX).toBeLessThan(40);
  });
});

describe("contact sheet with real ffmpeg", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "contact-sheet-"));
    for (const [index, colour] of ["red", "green", "blue"].entries()) {
      execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=${colour}:s=320x180:d=1`, "-frames:v", "1", join(root, `moment-0${index + 1}.png`)]);
    }
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("writes one private image tiling every screenshot", async () => {
    const name = await buildContactSheet(root, [
      { record: 1, time: "00:00:01", screenshot: "moment-01.png" },
      { record: 2, time: "00:00:02", screenshot: "moment-02.png" },
      { record: 3, time: "00:00:03", screenshot: "moment-03.png" },
    ]);
    expect(name).toBe("contact-sheet.png");
    const path = join(root, "contact-sheet.png");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const layout = contactSheetLayout(3);
    const size = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", path]).toString().trim();
    expect(size).toBe(`${layout.width},${layout.height}`);
  });

  it("skips unsafe names and fails closed on an unreadable screenshot", async () => {
    expect(await buildContactSheet(root, [{ record: 1, time: "00:00:01", screenshot: "../etc.png" }])).toBeUndefined();
    expect(await buildContactSheet(root, [{ record: 1, time: "00:00:01", screenshot: "moment-99.png" }])).toBeUndefined();
  });
});
