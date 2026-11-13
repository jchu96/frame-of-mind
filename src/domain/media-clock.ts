import { z } from "zod";

export const MEDIA_CLOCKS = ["source", "reel", "timeline"] as const;
export const mediaClockSchema = z.enum(MEDIA_CLOCKS);
export type MediaClock = z.infer<typeof mediaClockSchema>;
