import * as exactTime from "exact-time";
import { z } from "zod";

function storedField<T>(validator: { parse(value: unknown): T }) {
  return z.transform((value, ctx) => {
    try {
      return validator.parse(value);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error)) throw error;
      ctx.issues.push({ code: "custom", input: value, message: `${error.code}: ${error.message}` });
      return z.NEVER;
    }
  });
}

export const mediaClockSchema = storedField(exactTime.mediaClockSchema);
export const rateSchema = storedField(exactTime.rateSchema);
export const timecodeSpecSchema = storedField(exactTime.timecodeSpecSchema);
