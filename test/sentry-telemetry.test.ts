import { describe, expect, it } from "vitest";
import {
  scrubSentryEvent,
  telemetryCodeFromError,
  type ScrubbableSentryEvent,
} from "../src/lib/sentry-telemetry.js";

describe("Sentry telemetry privacy scrubber", () => {
  it.each([
    "[00:00:01] Speaker 1: private transcript line",
    "/Users/example/private/recording.mp4",
    "https://example.com/watch?token=private",
    "GEMINI_API_KEY=AIzaSySyntheticSecret012345678901",
    "a".repeat(64),
    "meeting_id=private-meeting-123",
    "person@example.com",
  ])("drops unsafe exception text: %s", (value) => {
    expect(scrubSentryEvent({
      exception: { values: [{ type: "Error", value }] },
    })).toBeNull();
  });

  it("keeps only code-shaped errors and allowlisted metadata", () => {
    const event: ScrubbableSentryEvent = {
      exception: {
        values: [{
          type: "Error",
          value: "analysis_failed",
          stacktrace: { frames: [{ filename: "/Users/example/private.ts" }] },
          mechanism: { handled: true, type: "generic", data: { private: true } },
        }],
      },
      extra: { transcript: "private transcript line" },
      breadcrumbs: [
        { type: "http", data: { url: "https://example.com/?token=private" } },
        { type: "navigation", message: "/runs/private" },
        { type: "console", message: "AIzaSySyntheticSecret012345678901" },
      ],
      request: {
        data: "private request body",
        cookies: { session: "private" },
        headers: { authorization: "Bearer private" },
        url: "https://example.com/?token=private",
      },
      user: { email: "person@example.com", ip_address: "127.0.0.1" },
      tags: {
        code: "analysis_failed",
        stage: "interrogating",
        jobId: "job_123",
        model: "/Users/example/private-model",
        meetingId: "private-meeting-123",
      },
      contexts: {
        recipeId: { value: "issue-review" },
        model: { value: "person@example.com" },
        response: { body: "private" },
      },
      transaction: "/api/studio/jobs/private",
      server_name: "private-host",
    };

    expect(scrubSentryEvent(event)).toEqual({
      exception: {
        values: [{
          type: "SanitizedTelemetryError",
          value: "analysis_failed",
          mechanism: { handled: true, type: "generic" },
        }],
      },
      tags: {
        code: "analysis_failed",
        stage: "interrogating",
        jobId: "job_123",
      },
      contexts: {
        recipeId: { value: "issue-review" },
      },
    });
    expect(JSON.stringify(event)).not.toContain("private transcript");
    expect(JSON.stringify(event)).not.toContain("person@example.com");
    expect(JSON.stringify(event)).not.toContain("/Users/example");
  });

  it("reduces provider statuses to code-only telemetry", () => {
    expect(telemetryCodeFromError({ status: 503 }, "analysis_failed"))
      .toBe("gemini_http_503");
    expect(telemetryCodeFromError(
      { telemetryCode: "gemini_http_429" },
      "analysis_failed",
    )).toBe("gemini_http_429");
    expect(telemetryCodeFromError(
      new Error("private provider response body"),
      "analysis_failed",
    )).toBe("analysis_failed");
  });
});
