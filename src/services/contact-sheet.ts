import { childEnvironment, spawn } from "../lib/child-env.js";
import { access, chmod, rm } from "node:fs/promises";
import { join } from "node:path";

/** One tile: a moment screenshot in the bundle and its label. */
export interface ContactSheetEntry {
  /** Record number as numbered in analysis.md and report.html. */
  record: number;
  /** Cited time, canonical HH:MM:SS. */
  time: string;
  /** Screenshot basename inside the bundle directory. */
  screenshot: string;
}

export const CONTACT_SHEET_NAME = "contact-sheet.png";

// Tiles are 16:9 thumbnails with a label strip underneath. ffmpeg decodes and
// encodes; the sheet and its labels are composed here so no font library or
// ffmpeg text filter is needed (common ffmpeg builds ship without drawtext).
const TILE_WIDTH = 384;
const TILE_HEIGHT = 216;
const LABEL_HEIGHT = 36;
const GAP = 8;
const MAX_COLUMNS = 4;
/** The sheet holds at most this many tiles; later screenshots are left off. */
export const CONTACT_SHEET_MAX_TILES = 100;
const SCALE = 3;
const BACKGROUND = [24, 28, 27] as const;
const INK = [237, 243, 241] as const;

// 5x7 glyphs for the only characters a label uses.
const GLYPHS: Record<string, readonly string[]> = {
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
  ":": ["00000", "01100", "01100", "00000", "01100", "01100", "00000"],
  "#": ["01010", "01010", "11111", "01010", "11111", "01010", "01010"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
};

export function contactSheetLabel(entry: ContactSheetEntry): string {
  return `#${entry.record}  ${entry.time}`;
}

/** Lays out a sheet and returns its size; exported for tests. */
export function contactSheetLayout(count: number): { columns: number; rows: number; width: number; height: number } {
  const columns = Math.min(MAX_COLUMNS, Math.max(1, count));
  const rows = Math.max(1, Math.ceil(count / columns));
  return {
    columns,
    rows,
    width: GAP + columns * (TILE_WIDTH + GAP),
    height: GAP + rows * (TILE_HEIGHT + LABEL_HEIGHT + GAP),
  };
}

/** Draws `text` into an RGB24 canvas; unknown characters are skipped. */
export function drawLabel(canvas: Buffer, canvasWidth: number, x: number, y: number, text: string): void {
  // Whole pixels only: a fractional row would shift the label sideways by a
  // fraction of the canvas width.
  const top = Math.floor(y);
  let cursor = Math.floor(x);
  for (const character of text) {
    const glyph = GLYPHS[character];
    if (!glyph) continue;
    for (const [row, bits] of glyph.entries()) {
      for (const [column, bit] of [...bits].entries()) {
        if (bit !== "1") continue;
        for (let dy = 0; dy < SCALE; dy += 1) {
          for (let dx = 0; dx < SCALE; dx += 1) {
            const pixelX = cursor + column * SCALE + dx;
            if (pixelX >= canvasWidth) continue;
            const offset = ((top + row * SCALE + dy) * canvasWidth + pixelX) * 3;
            if (offset < 0 || offset + 2 >= canvas.length) continue;
            canvas[offset] = INK[0];
            canvas[offset + 1] = INK[1];
            canvas[offset + 2] = INK[2];
          }
        }
      }
    }
    cursor += 6 * SCALE;
  }
}

function runFfmpeg(args: string[], input?: Buffer): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], {
      env: childEnvironment("media"),
      stdio: [input ? "pipe" : "ignore", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.once("error", () => resolve(undefined));
    child.once("close", (code) => resolve(code === 0 ? Buffer.concat(chunks) : undefined));
    if (input) {
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(input);
    }
  });
}

/**
 * Writes `contact-sheet.png` into `directory`, tiling the given screenshots in
 * order with their record number and cited time. Returns the basename, or
 * undefined when there is nothing to tile or ffmpeg fails; the sheet is a
 * review convenience and never fails a run.
 */
export async function buildContactSheet(
  directory: string,
  entries: readonly ContactSheetEntry[],
): Promise<string | undefined> {
  const tiles = entries.filter((entry) => /^moment-\d+\.png$/.test(entry.screenshot)).slice(0, CONTACT_SHEET_MAX_TILES);
  if (!tiles.length) return undefined;
  const layout = contactSheetLayout(tiles.length);
  const canvas = Buffer.alloc(layout.width * layout.height * 3);
  for (let offset = 0; offset < canvas.length; offset += 3) {
    canvas[offset] = BACKGROUND[0];
    canvas[offset + 1] = BACKGROUND[1];
    canvas[offset + 2] = BACKGROUND[2];
  }
  for (const [index, entry] of tiles.entries()) {
    const pixels = await runFfmpeg([
      "-i", join(directory, entry.screenshot),
      "-frames:v", "1",
      "-vf", `scale=${TILE_WIDTH}:${TILE_HEIGHT}:force_original_aspect_ratio=decrease,pad=${TILE_WIDTH}:${TILE_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=0x181c1b`,
      "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
    ]);
    if (!pixels || pixels.length !== TILE_WIDTH * TILE_HEIGHT * 3) return undefined;
    const left = GAP + (index % layout.columns) * (TILE_WIDTH + GAP);
    const top = GAP + Math.floor(index / layout.columns) * (TILE_HEIGHT + LABEL_HEIGHT + GAP);
    for (let row = 0; row < TILE_HEIGHT; row += 1) {
      pixels.copy(
        canvas,
        ((top + row) * layout.width + left) * 3,
        row * TILE_WIDTH * 3,
        (row + 1) * TILE_WIDTH * 3,
      );
    }
    drawLabel(canvas, layout.width, left + 4, top + TILE_HEIGHT + (LABEL_HEIGHT - 7 * SCALE) / 2, contactSheetLabel(entry));
  }
  const destination = join(directory, CONTACT_SHEET_NAME);
  const encoded = await runFfmpeg([
    "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${layout.width}x${layout.height}`, "-i", "pipe:0",
    "-frames:v", "1", destination,
  ], canvas);
  try {
    if (encoded === undefined) throw new Error("encode failed");
    await access(destination);
    await chmod(destination, 0o600);
    return CONTACT_SHEET_NAME;
  } catch {
    await rm(destination, { force: true });
    return undefined;
  }
}
