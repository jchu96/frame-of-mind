// Independent contract oracle: sequential labels, not the production DF formula.
// A ten-minute cycle repeats; skip whole cycles for unbounded hours.
export type Case = {
  id: string; op: string; input: string; clock?: "source" | "reel" | "timeline";
  rate?: { num: number; den: number }; dropFrame?: boolean; offset?: string;
  expected?: Record<string, unknown>; refused?: string; otio?: { differs: boolean; reason: string };
};
const cycles = new Map<string, string[]>();
export function oracleLabel(frame: bigint, num: number, den: number, drop: boolean): string {
  const nominal = Number((BigInt(num) + BigInt(den) - 1n) / BigInt(den));
  const key = `${nominal}/${drop}`;
  if (!cycles.has(key)) {
    const labels: string[] = [];
    let minute = 0, second = 0, field = 0;
    while (minute < 10) {
      labels.push(`${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}${drop ? ";" : ":"}${String(field).padStart(2, "0")}`);
      if (++field === nominal) {
        field = 0;
        if (++second === 60) { second = 0; minute++; if (drop && minute % 10 !== 0) field = nominal === 60 ? 4 : 2; }
      }
    }
    cycles.set(key, labels);
  }
  const labels = cycles.get(key)!;
  const cycle = frame / BigInt(labels.length);
  const label = labels[Number(frame % BigInt(labels.length))]!;
  const minute = cycle * 10n + BigInt(label.slice(0, 2));
  return `${String(minute / 60n).padStart(2, "0")}:${String(minute % 60n).padStart(2, "0")}${label.slice(2)}`;
}
function rateParts(row: Case) {
  let num = BigInt(row.rate?.num ?? 1000), den = BigInt(row.rate?.den ?? 1);
  let a = num, b = den;
  while (b !== 0n) { const r = a % b; a = b; b = r; }
  num /= a; den /= a;
  return { num, den };
}
/** Each accepted row is recomputed from its input, never from its expected frame. */
export function oracle(row: Case): Record<string, unknown> {
  if (row.op === "rate") {
    const aliases: Record<string, [number, number, boolean]> = {
      "48000/2002": [24000,1001,false], "23.976": [24000,1001,false], "47.952": [48000,1001,false],
      "29.97ndf": [30000,1001,false], "59.94df": [60000,1001,true],
    };
    const [num, den, dropFrame] = aliases[row.input]!;
    return { rate: { num, den }, dropFrame, rateOrigin: "declared" };
  }
  const { num, den } = rateParts(row);
  let frames: bigint;
  switch (row.op) {
    case "milliseconds": frames = BigInt(row.input) * num / (1000n * den); break;
    case "ticks": frames = BigInt(row.input) * num / (254016000000n * den); break;
    case "offset": frames = BigInt(row.input) + BigInt(row.offset!); break;
    case "timecode": {
      // Search the independently counted labels for this bounded table input.
      frames = 0n;
      while (oracleLabel(frames, Number(num), Number(den), row.dropFrame!) !== row.input) {
        if (++frames > 40000n) throw new Error(`Oracle label not found: ${row.id}`);
      }
      break;
    }
    case "frames": frames = BigInt(row.input); break;
    default: throw new Error(`Unknown oracle operation: ${row.op}`);
  }
  // Definition of first integer ms inside a frame, via quotient/remainder.
  const numerator = frames * den * 1000n;
  let ms = numerator / num;
  if (numerator % num !== 0n) ms++;
  const result: Record<string, unknown> = { clock: row.clock, seconds: `${ms / 1000n}.${String(ms % 1000n).padStart(3, "0")}` };
  if (254016000000n * den % num !== 0n) result.ticksUnavailable = "Ticks per frame are not whole at this rate.";
  else result.ticks = String(frames * (254016000000n * den / num));
  if (!row.rate) return { ...result, milliseconds: String(frames), rateBasis: "whole-millisecond source; no declared video rate" };
  return { ...result, frames: String(frames), rate: { num: Number(num), den: Number(den) },
    timecode: oracleLabel(frames, Number(num), Number(den), row.dropFrame!), dropFrame: row.dropFrame };
}
/** Independent reason classification for every negative table input. */
export function oracleRefusal(row: Case): string {
  if (row.op === "rate") return "Unsupported or ambiguous timecode rate.";
  const { num, den } = rateParts(row);
  if (row.op !== "timecode") {
    if (row.input.trim() !== row.input || !/^(0|[1-9][0-9]*)$/.test(row.input)) return "Expected a non-negative unpadded whole number.";
    if (row.op === "ticks") return 254016000000n * den % num !== 0n
      ? "Ticks per frame are not whole at this rate." : "Ticks must identify an exact frame boundary.";
  }
  if (row.dropFrame === undefined) return "Drop-frame must be stated.";
  if (row.dropFrame && !(den === 1001n && (num === 30000n || num === 60000n))) return "Drop-frame requires 30000/1001 or 60000/1001.";
  const fields = row.input.split(/[:;]/);
  if (row.input.trim() !== row.input || fields.length !== 4 || fields.some(f => !/^\d{2,}$/.test(f)) || Number(fields[1]) >= 60 || Number(fields[2]) >= 60) return "Malformed timecode.";
  if (row.input.includes(";") !== row.dropFrame) return "Timecode separator must match the stated drop-frame choice.";
  if (BigInt(fields[3]!) * den >= num) return "Frame field must be below the nominal rate.";
  if (row.dropFrame && Number(fields[1]) % 10 !== 0 && fields[2] === "00" && Number(fields[3]) < (num === 60000n ? 4 : 2)) return "Drop-frame label does not exist.";
  throw new Error(`Refusal not independently justified: ${row.id}`);
}
