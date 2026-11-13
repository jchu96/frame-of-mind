// Verbatim transcription is bounded by the model's output budget, not the
// audio length, so long recordings are transcribed in windows with a short
// lead-in overlap for boundary context.
export const TRANSCRIPTION_WINDOW_SECONDS = 600;
export const TRANSCRIPTION_OVERLAP_SECONDS = 15;
