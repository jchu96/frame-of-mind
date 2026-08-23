import { test, expect } from "@playwright/test";
import { requiresLocalStudioSession } from "../../server-local/studio-session/session";

// REVIEW-fom-93.md and REVIEW-fom-93-delta.md: the spike entry must share the
// Local Studio session matcher before any request body can be accepted.
test("@adversarial spike upload is a named session-protected fixture", () => {
  expect(requiresLocalStudioSession("/api/__studio-spike/upload")).toBe(true);
});
