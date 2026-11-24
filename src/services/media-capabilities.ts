import { extname } from "node:path";
import { runMediaTool } from "./media-tools.js";

const videoInputs = "demuxer:mov|matroska|avi";
const probe = [`ffprobe/${videoInputs}`];
const decode = [...probe, videoInputs, "muxer:null", "encoder:wrapped_avframe", "encoder:pcm_s16le"];
const encode = [...decode, "encoder:libx264", "encoder:aac", "muxer:mp4", "demuxer:lavfi", "demuxer:mov",
  "ffprobe/demuxer:mov", ...["trim", "setpts", "fps", "scale", "anullsrc", "atrim", "aresample",
    "aformat", "asetpts", "amix"].map(name => "filter:" + name)];
const image = [...probe, videoInputs, "filter:trim", "filter:setpts", "muxer:image2", "muxer:null", "encoder:wrapped_avframe"];
const calibrate = ["encoder:libx264", "filter:color", "filter:drawbox", "demuxer:lavfi", "muxer:mp4"];
const transcribe = ["ffprobe/version", "encoder:aac", "muxer:adts"];
const snap = ["encoder:pcm_s16le", "filter:atrim", "muxer:framecrc", "muxer:s16le", "muxer:tee"];

const commands = {
  probe, "probe --decode-check": decode, verify: decode, proxy: encode, slice: encode,
  "frame (PNG)": [...image, "encoder:png", "demuxer:png_pipe", "ffprobe/demuxer:png_pipe"],
  "frame (JPEG)": [...image, "encoder:mjpeg", "demuxer:jpeg_pipe", "ffprobe/demuxer:jpeg_pipe"],
  transcribe, snap, calibrate,
  "analyze (optional calibration)": calibrate, "analyze (optional derived transcript)": transcribe,
  "analyze (optional speech snapping)": snap, "analyze (optional media rate)": probe,
  "analyze (optional screenshots)": ["encoder:png", "muxer:image2"],
  "analyze (optional settled screenshots)": ["encoder:png", "muxer:image2", "filter:fps", "filter:split",
    "filter:scale", "filter:format", "encoder:rawvideo", "muxer:rawvideo"],
  "analyze (optional contact sheet)": ["encoder:png", "encoder:rawvideo", "muxer:image2", "muxer:rawvideo",
    "demuxer:rawvideo", "demuxer:png_pipe", "filter:scale", "filter:pad"],
};

type Binary = "ffmpeg" | "ffprobe";
type Listing = "version" | "encoders" | "filters" | "formats";
const listings = { version: "version", encoder: "encoders", filter: "filters", muxer: "formats", demuxer: "formats" } as const;

async function readListing(binary: Binary, listing: Listing, signal?: AbortSignal) {
  let output: string;
  try {
    output = await runMediaTool(binary, ["-" + listing], {signal, timeoutMs: 5000, maxOutput: 1024 * 1024});
  } catch (error) {
    signal?.throwIfAborted();
    return {error: (error as NodeJS.ErrnoException).code === "ENOENT" ? "not installed" : `cannot read -${listing}`};
  }
  if (listing === "version") {
    const version = output.split(/\r?\n/, 1)[0];
    return version?.startsWith(binary + " version ") ? {version} : {error: "unrecognized version"};
  }
  const capabilities = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    if (listing === "formats") {
      const match = /^ ([D ])([E ])[d ]?\s+(\w[\w,]*)\s/.exec(line);
      if (!match) continue;
      for (const name of match[3]!.split(",")) {
        if (match[1] === "D") capabilities.add("demuxer:" + name);
        if (match[2] === "E") capabilities.add("muxer:" + name);
      }
    } else {
      const match = (listing === "encoders" ? /^\s*[VAS][A-Z.]{5}\s+(\w+)\s/ : /^\s*[TSC.]{1,3}\s+(\w+)\s/).exec(line);
      if (match) capabilities.add((listing === "filters" ? "filter:" : "encoder:") + match[1]);
    }
  }
  return {capabilities};
}

function inventory(signal?: AbortSignal) {
  const cache = new Map<string, ReturnType<typeof readListing>>();
  function get(binary: Binary, listing: Listing) {
    const key = binary + "/" + listing;
    if (!cache.has(key)) cache.set(key, readListing(binary, listing, signal));
    return cache.get(key)!;
  }
  async function check(name: string) {
    const binary = name.startsWith("ffprobe/") ? "ffprobe" : "ffmpeg";
    const [kind, names] = name.replace("ffprobe/", "").split(":");
    const listing = listings[kind as keyof typeof listings];
    const result = await get(binary, listing);
    const present = !result.error && (listing === "version" ||
      names!.split("|").some(value => result.capabilities?.has(kind + ":" + value)));
    return {name, present, error: result.error ? `${binary} ${result.error}` : null};
  }
  return {get, check};
}

export async function mediaCapabilityReport() {
  const {get, check} = inventory();
  async function tool(binary: Binary) {
    const [info] = await Promise.all((["version", "encoders", "filters", "formats"] as const).map(listing => get(binary, listing)));
    return {version: info!.version ?? null, error: info!.error ?? null};
  }
  const [ffmpeg, ffprobe] = await Promise.all([tool("ffmpeg"), tool("ffprobe")]);
  const rows = await Promise.all(Object.entries(commands).map(async ([command, needs]) =>
    ({command, capabilities: await Promise.all(needs.map(check))})));
  return {tools: {ffmpeg, ffprobe}, commands: rows};
}

export async function requireMedia(command: keyof typeof commands | "frame", flags: {output?: string; decodeCheck?: boolean} = {}, signal?: AbortSignal) {
  const variant = command === "frame" ? (extname(flags.output ?? "").toLowerCase() === ".png" ? "frame (PNG)" : "frame (JPEG)")
    : command === "probe" && flags.decodeCheck ? "probe --decode-check" : command;
  const results = await Promise.all(commands[variant].map(inventory(signal).check));
  const absent = results.filter(row => !row.present).map(row => row.error ? `${row.name} (${row.error})` : row.name);
  if (absent.length) throw new Error(`${command} requires missing media capabilities: ${absent.join(", ")}.`);
}
