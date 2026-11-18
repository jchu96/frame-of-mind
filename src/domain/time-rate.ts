import { z } from "zod";

const safeNatural = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveInteger = safeNatural.min(1);
export const rateSchema = z.strictObject({ num: positiveInteger, den: positiveInteger });
export type FrameRate = z.infer<typeof rateSchema>;
export const timecodeSpecSchema = z.strictObject({
  rate: rateSchema, dropFrame: z.boolean(), rateOrigin: z.enum(["declared", "media"]),
}).refine((v) => !v.dropFrame || isDropRate(v.rate), "Drop-frame requires 30000/1001 or 60000/1001.");
export type TimecodeSpec = z.infer<typeof timecodeSpecSchema>;

export const ACCEPTED_RATES = "24, 25, 30, 48, 50, 60; 23.976, 47.952; 29.97df, 29.97ndf, 59.94df, 59.94ndf; N/D (optionally :df or :ndf); from-media, from-media:df, from-media:ndf";
export function rateError(): never { throw new Error(`Unsupported or ambiguous timecode rate. Accepted forms: ${ACCEPTED_RATES}. Drop-frame must be stated for 30000/1001 and 60000/1001.`); }
export function rationalRate(num: number, den: number): FrameRate {
  rateSchema.parse({ num, den });
  let a = num; let b = den;
  while (b) { const remainder = a % b; a = b; b = remainder; }
  return { num: num / a, den: den / a };
}
export function isDropRate(rate: FrameRate): boolean {
  return BigInt(rate.num) * BigInt(1001) === BigInt(30000) * BigInt(rate.den)
    || BigInt(rate.num) * BigInt(1001) === BigInt(60000) * BigInt(rate.den);
}
export function parseTimecodeRate(value: string): TimecodeSpec {
  const match = /^(.*?)(?::?(ndf|df))?$/.exec(value);
  if (!match || match[0] !== value) rateError();
  const name = match[1]!; const choice = match[2];
  const aliases: Record<string, FrameRate> = {
    "23.976": { num: 24000, den: 1001 }, "47.952": { num: 48000, den: 1001 },
    "29.97": { num: 30000, den: 1001 }, "59.94": { num: 60000, den: 1001 },
  };
  let rate = Object.hasOwn(aliases, name) ? aliases[name] : undefined;
  if (!rate && /^(24|25|30|48|50|60)$/.test(name)) rate = { num: Number(name), den: 1 };
  if (!rate && /^[1-9]\d*\/[1-9]\d*$/.test(name)) {
    const [num, den] = name.split("/").map(Number);
    try { rate = rationalRate(num!, den!); } catch { rateError(); }
  }
  if (!rate || (isDropRate(rate) && !choice) || (choice === "df" && !isDropRate(rate))) rateError();
  return { rate, dropFrame: choice === "df", rateOrigin: "declared" };
}
