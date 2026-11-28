import { chmod, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createScratch } from "../adapters/scratch.js";
import type { RangeClock } from "../domain/range-clock.js";
import { boundIndex, sourceBound, type Bound, type ExactSpan } from "../domain/source-bound.js";
import { localRecording } from "./media-tools.js";
import { runRecordingTool } from "./audio-range.js";
import { pickSettledFrame } from "./screenshots.js";

export interface PicturePosition {
  clock: RangeClock;
  span: ExactSpan;
  target: Bound;
  captured: (bound: Bound) => void;
}

// PNG filenames are the decoder's presentation timestamps, in the selected grid.
// The thumbnail and the saved picture come from the same split filter.
export async function captureSourcePicture(video: string, path: string, p: PicturePosition, settled: boolean): Promise<boolean> {
  const {clock} = p, {num,den} = clock.grid.rate;
  const target = clock.cutIndex(boundIndex(p.target));
  const lo = clock.cutIndex(boundIndex(p.span.start)), hi = clock.cutIndex(boundIndex(p.span.endExclusive));
  const radius = settled ? clock.unitsForSeconds(1, true) : 0n;
  const start = target-radius > lo ? target-radius : lo;
  if (start >= hi) return false;
  const stop = target + radius + 1n < hi ? target + radius + 1n : hi;
  const dir = await createScratch("screenshots",dirname(path));
  try {
    const source = await localRecording(video);
    // With VFR, the next displayed picture may follow the model's instant.
    const limit = !settled && clock.grid.unit === "ticks" ? hi : stop;
    const predicate = `gte(pts,${start})*lt(pts,${limit})` + (settled ? "*(isnan(prev_selected_t)+gte(t-prev_selected_t,0.199999))" : "");
    const seek = Math.max(0, clock.elapsed(start) - 1);
    const thumbs = join(dir,"thumbs.gray");
    const filter = `[0:V:0]settb=${den}/${num},select='${predicate}',trim=end_frame=${settled ? 12 : 1},split[image][small];[small]scale=64:36:flags=area,format=gray[thumb]`;
    await runRecordingTool(source,"ffmpeg",["-copyts","-start_at_zero","-ss",String(seek),"-t",String(clock.elapsed(limit)-seek+1),
      "-i","fd:","-filter_complex",filter,"-map","[image]","-fps_mode","passthrough",
      "-enc_time_base",`${den}/${num}`,"-frame_pts","1",join(dir,"%d.png"),
      "-map","[thumb]","-fps_mode","passthrough","-f","rawvideo",thumbs], {});
    const keys = (await readdir(dir)).filter(n => /^\d+\.png$/.test(n)).map(n => BigInt(n.slice(0,-4))).sort((a,b) => a < b ? -1 : 1);
    if (!keys.length || keys.some(k => k<lo || k>=hi)) return false;
    const data = await readFile(thumbs), bytes = 64*36;
    if (data.length !== keys.length*bytes) return false;
    let nearest = 0;
    for (let i=1;i<keys.length;i++) if (Math.abs(Number(keys[i]!-target)) < Math.abs(Number(keys[nearest]!-target))) nearest=i;
    const chosen = settled ? pickSettledFrame(keys.map((_,i) => data.subarray(i*bytes,(i+1)*bytes)),nearest) ?? nearest : nearest;
    const k = keys[chosen]!;
    await rename(join(dir,`${k}.png`),path);
    await chmod(path,0o600);
    p.captured(sourceBound(clock,clock.sourceIndex(k)));
    return true;
  } catch { return false; }
  finally { await rm(dir,{recursive:true,force:true}); }
}
