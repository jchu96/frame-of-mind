import { z } from "zod";

export const DEFAULT_GEMINI_MODEL = "gemini-3.7-flash";

export const geminiModelSchema = z.string()
  .min(1)
  .max(120)
  .regex(/^gemini-[a-z0-9][a-z0-9.-]*$/, "expected a Gemini model ID");
