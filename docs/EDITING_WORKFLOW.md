# From a Premiere Pro sequence to a source frame

Use a small export to find a moment worth cutting. Keep the timeline export
beside it so you can trace that moment back to the original clip.

## Export the same edit twice

1. Export a small video of the **entire sequence** as `edit.mp4`. Keep the
   sequence frame rate and include the audio. The first frame of the video
   must correspond to the first frame of the sequence for this example.
2. With that sequence selected in Premiere Pro, choose **File > Export >
   OpenTimelineIO** and save `edit.otio`. A panel can make the same export
   with `ProjectConverter.exportAsOpenTimelineIO(sequence, outputFilePath, suppressUI)`.
   The menu and panel produced identical bytes in Premiere Pro 26.5.3.
3. If you change a cut, export both files again. A frame number from an older
   cut can land on a different clip in the new timeline.

## Find a moment and listen to its edges

With a Gemini API key configured, run this in the folder containing the two
exports. The example looks for decisions. The video starts at sequence frame
zero and runs at 23.976 fps.

```bash
frameofmind analyze --source none --video edit.mp4 --recipe decisions --timeline-offset 0 --timecode-rate 23.976 --snap speech
```

Open `report.html` in the run folder to choose a moment. In `times.json`,
find its candidate start or end. The model time has one-second precision.
A successful snap adds a proposed edge from the local audio. To check just
one edge, use the standalone command. Here the proposed start is near four seconds.

```bash
frameofmind snap edit.mp4 --at 4 --edge start
```

Use `--edge end` for the end of a phrase. Listen around the proposal before
cutting. The meter measures on a 10 ms grid and is accurate to about ±50 ms
when the first audio stream is at least 32 kHz, or ±200 ms at lower or
unknown rates. If there is no clear edge, review the model time and any
listed alternatives. [How to read the analysis](VIDEO_UNDERSTANDING.md#reading-the-result)

## Trace the frame to the source

For a snapped edge in this zero-offset run, take `snap.frameReference.frames`
from `times.json`. It identifies the frame containing the onset, or the last
speech millisecond before an exclusive end. The uncertainty can span adjacent
frames. In this example a proposed start at 4.180 seconds falls **inside**
frame 100. Pass the frame number with an `f` suffix.

```bash
frameofmind map edit.otio --at 100f
```

With the [23.976 sample timeline](../test/fixtures/timeline-export-23976.otio)
as `edit.otio`, the command prints these two lines.

```text
sequence frame 100 (00:00:04:04 non-drop)
track 1 (Video 1) · count-b-23976-tc1h.mov · /placeholder/project/media/count-b-23976-tc1h.mov · file value 86500 · media frame 100 · missing source file
```

**Media frame 100** counts from the first frame of the original file. Use it
to grab a still or make a slice. **File value 86500** includes the source's
start timecode. To find all uses of a source frame, pass its file value to
`--frame` and the path from the result to `--source`. A repeated shot can
lead to several sequence positions.

The sample contains a placeholder path. With the original file in place,
`map` uses ffprobe to check its rate and start timecode. The file's tags
must agree, its rate must match the media reference, and the start label
must identify the first frame of the reference's available range. Only then
does the row include source timecode. Otherwise it keeps the two frame
numbers and explains why the label is unavailable.

At an ordinary cut, the incoming clip owns the first frame after the cut.
Elsewhere the answer depends on what the track contains.

| What is under the playhead | What the lookup tells you |
| --- | --- |
| Clips on several video tracks | One row per included track at that frame, top first. Use `--track 1` for the bottom video track. Check visibility and compositing in the editor. |
| Gap | That track has no source there. |
| Transition | The row names both neighboring clips. Their handles overlap during the transition. |
| Speed change | The row names the clip and refuses a source frame. The measured export stores a time-warp effect and a range in sequence frames. That range alone cannot identify the played source frame. |
| Nested sequence | The row names the nest. Open it in the editor to locate the inner clip. |

For example, use the [timeline with a speed change](../test/fixtures/timeline-export-refusals.otio)
as `edit.otio` and repeat the same frame-100 lookup.

```text
sequence frame 100 (00:00:04:04 non-drop)
track 1 (Video 1) · refused: count-a-23976.mov · time effect LinearTimeWarp.1
```

## Read a sequence timecode

Frame counts and decimal seconds start at sequence frame zero. Seconds must
land exactly on a frame boundary and take at most three decimal places.
A timecode label uses the sequence's display clock, including its start.
Drop-frame skips label numbers to keep that clock close to elapsed time.
For example, 29.97 drop-frame advances from `00:00:59;29` to `00:01:00;02`
on consecutive frames.

The measured OTIO exports carry no drop-frame flag. `map` chooses the
display mode in this order.

1. **Declared mode.** Supply the matching rate and mode with `--timecode-rate`,
   for example `29.97df` or `29.97ndf`.
2. **Sequence sidecar.** If present, `edit.otio.sequence.json` must have
   matching ticks per frame and zero point, and a valid boolean `dropFrame`.
3. **Exported video.** With `--video edit.mp4`, the reader checks the embedded
   `xmpDM:startTimecode` for the measured 29.97 drop or non-drop format.
   In the measured video exports ffprobe found no timecode tag.
4. **Frame rate.** A rate such as 23.976 permits only non-drop. If the rate
   allows both modes and the mode is still unknown, use a frame count for
   the lookup. The result prints both labeled timecodes.

## Grab a still or verify a selection locally

Use `probe` to inspect the export. If you have a larger render, `proxy`
makes a smaller upload copy at the same rate.

```bash
frameofmind probe edit.mp4
frameofmind proxy edit.mp4 -o proxy.mp4
```

With the mapped original in your working folder, grab source frame 100.
To keep frames 100 through 124, stop the slice at 125. Then verify the
25-frame result.

```bash
frameofmind frame count-b-23976-tc1h.mov --at 100f -o source.png
frameofmind slice count-b-23976-tc1h.mov --from 100f --to 125f -o selection.mp4
frameofmind verify selection.mp4 --expect-frames 25
```

These commands run locally. [FFmpeg requirements by command](RUNBOOK.md#ffmpeg-requirements-by-command)

## Tested exports

The export measurements cover Adobe Premiere Pro **26.5.3**, with **23.976**
and **29.97** sequences. The timelines contained three video and four audio
tracks, with clips only on the used tracks. They stored rates as the
floating-point values of 24000/1001 and 30000/1001 and positions as whole
frames, including the source's start timecode. Other sequence rates, Premiere
Pro versions and editing applications were not tested.
