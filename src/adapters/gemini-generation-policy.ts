// A structured Gemini step can make one initial generation plus one
// schema-repair generation. Each generation can retry transient transport
// failures before surfacing an error. Hosted spend reservations use these
// shared maxima so the admission ceiling covers every billable attempt.
export const GEMINI_GENERATION_TRANSPORT_RETRIES = 4;
export const GEMINI_GENERATION_TRANSPORT_ATTEMPTS =
  GEMINI_GENERATION_TRANSPORT_RETRIES + 1;
export const GEMINI_STRUCTURED_GENERATIONS_PER_STEP = 2;
